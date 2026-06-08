import express from "express";
import multer from "multer";
import fs from "fs";
import cors from "cors";
import Tesseract from "tesseract.js";
import OpenAI from "openai";
import dotenv from "dotenv";
import os from "os";
import path from "path";
import axios from "axios";
import { ApifyClient } from "apify-client";
import {
  GoogleGenerativeAI,
  HarmBlockThreshold,
  HarmCategory,
} from "@google/generative-ai";

import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { createClient } from "@supabase/supabase-js";
import { fileURLToPath } from "url";
import FormData from "form-data";

dotenv.config();

const app = express();
app.set("trust proxy", 1);

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/app-ads.txt", (req, res) => {
  res.set("Content-Type", "text/plain");
  res.sendFile(path.join(__dirname, "public", "app-ads.txt"));
});

const REVENUECAT_SECRET_KEY = process.env.REVENUECAT_SECRET_KEY;
const ENTITLEMENT_ID = "EzyCooking Pro";

const memUpload = multer({ storage: multer.memoryStorage() });
const upload = multer({ dest: "uploads/" });

const apifyClient = new ApifyClient({
  token: process.env.APIFY_TOKEN,
});

app.use((err, req, res, next) => {
  console.error("Global Error:", err.stack);
  res.status(500).send("Something broke!");
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) =>
    req.body?.device_id || req.body?.user_id || ipKeyGenerator(req.ip),
  handler: (_req, res) => {
    res.status(429).json({
      error: "Too many requests. Please wait a minute before trying again.",
    });
  },
});

/* =========================
   HEALTH CHECK
========================= */
app.get("/", (req, res) => {
  res.json({
    status: "OK",
    message: "SnapCook Backend is running!",
    timestamp: new Date().toISOString(),
  });
});

/* =========================================================
   🔥 EMAIL VERIFICATION FIX (SUPABASE CALLBACK HANDLER)
   ========================================================= */

app.get("/auth/callback", async (req, res) => {
  try {
    return res.sendFile(path.join(__dirname, "public", "email-verified.html"));
  } catch (err) {
    return res.status(500).send("Verification failed");
  }
});

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
console.log("🔍 GEMINI_API_KEY:", GEMINI_API_KEY ? "SET" : "NOT SET");

if (!GEMINI_API_KEY) {
  console.error("❌ Missing GEMINI_API_KEY in environment variables");
  console.error(
    "💡 Please set GEMINI_API_KEY in Railway environment variables",
  );
}

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// export async function processWithLLM(inputText, language = "en") {
//   // Map language codes to full names for better LLM understanding
//   const languageMap = {
//     en: "English",
//     fr: "French",
//     de: "German",
//     pt: "Portuguese",
//     es: "Spanish",
//   };

//   const languageName = languageMap[language] || "English";

//   const systemPrompt = `You are a helpful assistant that extracts recipe information from given text if present and returns only valid JSON with the following structure. IMPORTANT: All text in the response (title, ingredients, instructions, etc.) must be in ${languageName} language.

//   {
//     "title": string,
//     "ingredients": string[],
//     "instructions": string[],
//     "influencer": string (optional),
//     "nutritional_info": {
//       "total_calories": string,
//       "protein": string,
//       "carbs": string,
//       "fat": string
//     },
//     "cooking_time": string (optional),
//     "serving_size": string (optional)
//   }

//   Rules:
//   - Always return only JSON.
//   - All text content (title, ingredients, instructions) must be in ${languageName}.
//   - If any field is not present, leave it empty ("" or empty object/array).
//   - Each instruction step should be a complete detailed sentence in ${languageName}.
//   - Estimate total_calories, protein, carbs, and fat based on the ingredients and their mentioned quantities.
//   - Return approximate values for the entire recipe (not per 100g).
//   - for "serving_size": Extract number of servings. If a range is given (e.g. "2-3 servings" or "serves 2 to 3"), return the average as a single number (e.g. 2.5). Do NOT concatenate numbers (e.g. "2-3" ≠ 23). If unclear, return 1.
//   - Nutritional values can remain as numbers (they don't need translation).
//   `;

//   const userPrompt = `Text: ${inputText}`;

//   const response = await openai.chat.completions.create({
//     model: "gpt-4o-mini",
//     messages: [
//       { role: "system", content: systemPrompt },
//       { role: "user", content: userPrompt },
//     ],
//     temperature: 0,
//     response_format: { type: "json_object" },
//   });

//   const content = response.choices[0].message.content;

//   return JSON.parse(content);
// }

export async function processWithLLM(inputText, language = "en") {
  const languageMap = {
    en: "English",
    fr: "French",
    de: "German",
    pt: "Portuguese",
    es: "Spanish",
  };

  const raw = String(language || "en").trim();
  const code = raw.split(/[-_]/)[0].toLowerCase();
  const languageName = languageMap[code] || "English";

  const systemPrompt = `You are a helpful assistant that extracts recipe information from given text if present and returns only valid JSON with the following structure.

IMPORTANT:
- All human-readable text in the response (title, ingredients, instructions, optional influencer name if you include it, cooking_time and serving_size strings if present) must be written in ${languageName}.
- If the source text is in a different language, translate into ${languageName}. Do not leave recipe text in the source language.

{
  "title": string,
  "ingredients": string[],
  "instructions": string[],
  "influencer": string (optional),
  "nutritional_info": {
    "total_calories": string,
    "protein": string,
    "carbs": string,
    "fat": string
  },
  "cooking_time": string (optional),
  "serving_size": string (optional)
}

Rules:
- Always return only JSON.
- All text content (title, ingredients, instructions) must be in ${languageName}.
- If any field is not present, leave it empty ("" or empty object/array).
- Each instruction step should be a complete detailed sentence in ${languageName}.
- Estimate total_calories, protein, carbs, and fat based on the ingredients and their mentioned quantities.
- Return approximate values for the entire recipe (not per 100g).
- Nutritional numeric values may stay as digits inside the strings (no need to spell out numbers in words).
`;

  const userPrompt = `Text: ${inputText}`;

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0,
    response_format: { type: "json_object" },
  });

  const content = response.choices[0].message.content;
  return JSON.parse(content);
}

function getYouTubeId(url) {
  const match = url.match(
    /(?:youtube\.com\/(?:[^\/\n\s]+\/\S+\/|(?:v|e(?:mbed)?|shorts)\/|.*[?&]v=)|youtu\.be\/)([\w-]{11})/,
  );
  return match ? match[1] : null;
}

app.post("/url-extract", apiLimiter, async (req, res) => {
  const {
    url,
    language = "en",
    device_id,
    user_id,
    push_token,
    rc_app_user_id,
  } = req.body;
  if (!url) return res.status(400).json({ error: "URL is required" });

  // 1) Pre-flight quota check. Defense-in-depth: the client also checks
  //    before calling, but Pro/non-Pro is ultimately decided here.
  try {
    const quota = await checkQuotaAllowed(device_id, user_id, rc_app_user_id);
    if (!quota.allowed) {
      console.log(
        `🚫 Quota exceeded — device:${device_id} user:${user_id} rc:${rc_app_user_id} ${quota.count}/${quota.quotaTotal}`,
      );
      return res.status(402).json({
        error: "QUOTA_EXCEEDED",
        count: quota.count,
        quota_total: quota.quotaTotal,
      });
    }
  } catch (qErr) {
    console.error("Quota check failed:", qErr.message);
    // Graceful degrade: if the quota service is down, allow the extraction.
    // Better to over-serve than to block paying customers on a Supabase blip.
  }

  try {
    let captionText = "";
    let thumbnail = "";
    let influencer = "";

    if (url.includes("instagram.com")) {
      const result = await getInstagramCaptionAndThumbnail(url);
      captionText = result.caption;
      thumbnail = result.thumbnail;
      influencer = result.influencer || "";
    } else if (url.includes("youtube.com") || url.includes("youtu.be")) {
      url = cleanYouTubeUrl(url);
      const result = await getYouTubeDescriptionAndThumbnail(url);
      captionText = result.caption;
      thumbnail = result.thumbnail;
      influencer = result.influencer || "";
    } else if (url.includes("tiktok.com")) {
      const result = await getTikTokCaptionAndThumbnail(url);
      captionText = result.caption;
      thumbnail = result.thumbnail;
      influencer = result.influencer || "";
    }

    if (!captionText)
      return res.status(404).json({ error: "No caption found" });

    const structured = await processWithLLM(captionText, language);

    if (structured && typeof structured === "object") {
      structured.image = thumbnail;
      if (influencer && !structured.influencer) {
        structured.influencer = influencer;
      }
    }

    // 2) Persist to Supabase so the app can pick it up even if it was closed
    if (structured && device_id) {
      try {
        await supabaseAdmin.from("pending_imports").insert({
          device_id,
          user_id: user_id || null,
          recipe_data: structured,
          url,
          status: "completed",
        });
        console.log("✅ Saved pending import for device:", device_id);
      } catch (e) {
        console.error("Failed to save pending import:", e.message);
      }

      // Send push notification so user knows even if app is closed
      if (push_token) {
        try {
          await fetch("https://exp.host/--/api/v2/push/send", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: JSON.stringify({
              to: push_token,
              title: "Recipe Imported! 🎉",
              body: structured.title
                ? `"${structured.title}" is ready to view`
                : "Your recipe has been extracted. Tap to view.",
              data: { type: "recipe_imported" },
              sound: "default",
            }),
          });
          console.log("✅ Push notification sent to:", push_token);
        } catch (e) {
          console.error("Failed to send push notification:", e.message);
        }
      }
    }

    // 3) Increment quota counter — ONLY when extraction actually succeeded
    //    (structured is non-null). Failed extractions don't burn quota.
    if (structured && (device_id || user_id)) {
      try {
        const { data: usage, error: usageErr } = await supabaseAdmin.rpc(
          "increment_extraction_usage",
          {
            p_device_id: device_id || null,
            p_user_id: user_id || null,
          },
        );
        if (usageErr) {
          console.error("Failed to increment quota:", usageErr.message);
        } else {
          const row = Array.isArray(usage) ? usage[0] : usage;
          console.log(
            `📊 Quota incremented — device:${device_id} user:${user_id} → ${row?.count}/${row?.quota_total}`,
          );
        }
      } catch (e) {
        console.error("Increment quota threw:", e.message);
      }
    }

    res.status(200).json({ structured, thumbnail });
  } catch (error) {
    console.error("URL Extraction Error:", error);
    res
      .status(500)
      .json({ error: "Failed to process URL", detail: error.message });
  }
});

function cleanYouTubeUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);

    // Handle youtu.be links
    if (url.hostname.includes("youtu.be")) {
      const videoId = url.pathname.slice(1);
      return `https://www.youtube.com/watch?v=${videoId}`;
    }

    // Handle shorts
    if (url.pathname.includes("/shorts/")) {
      const videoId = url.pathname.split("/shorts/")[1].split("/")[0];
      return `https://www.youtube.com/watch?v=${videoId}`;
    }

    // Standard watch URL
    const videoId = url.searchParams.get("v");

    if (videoId) {
      return `https://www.youtube.com/watch?v=${videoId}`;
    }

    return rawUrl;
  } catch {
    return rawUrl;
  }
}

// Recimate Feature
app.post("/recipe-chat", apiLimiter, async (req, res) => {
  const { recipe, userMessage, history = [] } = req.body;
  if (!recipe || !userMessage) {
    return res
      .status(400)
      .json({ error: "recipe and userMessage are required" });
  }
  const ingredients = (recipe.ingredients ?? []).join(", ");
  const systemPrompt = `You are a recipe assistant. Answer only cooking, food, or nutrition questions.
For anything else reply exactly: "I can only help with cooking and recipe questions!"
Current recipe: ${recipe.title}
Ingredients: ${ingredients}
Rules:
- Return 1 clear sentence so the user can understand the suggestion unless the user asks for more detailed advice.
- Each bullet must be a specific, actionable change or substitution.
- Use exact quantities when relevant.
- Never repeat the question back to the user.
ALWAYS respond with a single valid JSON object — no markdown, no extra text:
{ "reply": "Your clear sentence here" }`;
  const recentHistory = (history ?? []).slice(-5);
  const messages = [
    { role: "system", content: systemPrompt },
    ...recentHistory,
    { role: "user", content: userMessage },
  ];
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      temperature: 0.6,
      max_tokens: 400,
    });
    const rawText = completion.choices[0]?.message?.content?.trim() ?? "";
    let cleanText = rawText
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "");
    const jsonMatch = cleanText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return res
        .status(200)
        .json({ reply: rawText || "I couldn't process that. Try again." });
    }
    const parsed = JSON.parse(jsonMatch[0]);
    res.status(200).json({ reply: parsed.reply ?? "Here's my suggestion." });
  } catch (error) {
    console.error("Recipe chat error:", error);
    res
      .status(500)
      .json({ error: "Failed to process request", detail: error.message });
  }
});

// Nutrition Estimate Feature
// app.post("/nutrition-estimate", apiLimiter, async (req, res) => {
//   const { title, ingredients, servings = 1 } = req.body;

//   if (!title || !Array.isArray(ingredients) || ingredients.length === 0) {
//     return res.status(400).json({ error: "title and ingredients are required" });
//   }

//   const ingredientList = ingredients.map((i) => `- ${i}`).join("\n");

//   const userPrompt =
//     `Recipe: ${title}\nServings: ${servings}\nIngredients:\n${ingredientList}\n\n` +
//     `First, check: are these actual food/cooking ingredients?\n` +
//     `- If NO (e.g. electronics, furniture, random words) → return exactly: { "valid": false }\n` +
//     `- If YES → calculate total nutrition for the ENTIRE recipe using the EXACT quantities listed ` +
//     `(e.g. "1000 ml oil" means 1000 ml, not 1 tbsp). ` +
//     `Then divide each value by ${servings} to get per-serving amounts. ` +
//     `Return integer values:\n` +
//     `{ "valid": true, "calories": <kcal/serving>, "protein": <g/serving>, "carbs": <g/serving>, ` +
//     `"fat": <g/serving>, "fiber": <g/serving>,\n` +
//     `  "micronutrients": { "iron": <mg/serving>, "calcium": <mg/serving>, "vitaminA": <mcg/serving>, ` +
//     `"vitaminC": <mg/serving>, "potassium": <mg/serving> } }`;

//   try {
//     const completion = await openai.chat.completions.create({
//       model: "gpt-4o-mini",
//       temperature: 0,
//       max_tokens: 400,
//       response_format: { type: "json_object" },
//       messages: [
//         {
//           role: "system",
//           content:
//             "You are a precise nutrition calculator. " +
//             "CRITICAL RULE: Always use the EXACT quantity and unit written for each ingredient — " +
//             "never substitute a default serving size. " +
//             "Sum nutrition across all ingredients for the whole recipe, then divide by servings. " +
//             "Respond with a single valid JSON object only — no markdown, no explanation.",
//         },
//         { role: "user", content: userPrompt },
//       ],
//     });

//     const rawText = completion.choices[0]?.message?.content?.trim() ?? "";
//     const jsonMatch = rawText.match(/\{[\s\S]*\}/);

//     if (!jsonMatch) {
//       return res.status(500).json({ error: "No JSON in OpenAI response" });
//     }

//     const parsed = JSON.parse(jsonMatch[0]);

//     if (parsed.valid === false) {
//       return res.status(422).json({ error: "INVALID_INGREDIENTS" });
//     }

//     res.status(200).json({
//       calories:  Math.round(Number(parsed.calories)  || 0),
//       protein:   Math.round(Number(parsed.protein)   || 0),
//       carbs:     Math.round(Number(parsed.carbs)      || 0),
//       fat:       Math.round(Number(parsed.fat)        || 0),
//       fiber:     Math.round(Number(parsed.fiber)      || 0),
//       micronutrients: {
//         iron:      Math.round(Number(parsed.micronutrients?.iron)      || 0),
//         calcium:   Math.round(Number(parsed.micronutrients?.calcium)   || 0),
//         vitaminA:  Math.round(Number(parsed.micronutrients?.vitaminA)  || 0),
//         vitaminC:  Math.round(Number(parsed.micronutrients?.vitaminC)  || 0),
//         potassium: Math.round(Number(parsed.micronutrients?.potassium) || 0),
//       },
//     });
//   } catch (error) {
//     console.error("Nutrition estimate error:", error);
//     res.status(500).json({ error: "Failed to estimate nutrition", detail: error.message });
//   }
// });

// async function checkQuotaAllowed(deviceId, userId, rc_app_user_id) {
//   if (!deviceId && !userId && !rc_app_user_id) return { allowed: true };
//   // RC is source of truth for Pro. For logged-in users rc_app_user_id should
//   // normally equal userId after Purchases.logIn(userId), but this fallback keeps
//   // older clients working if they don't send rc_app_user_id yet.
//   const rcAppUserId = rc_app_user_id || userId;
//   if (rcAppUserId) {
//     const isPro = await isRevenueCatPro(rcAppUserId);
//     if (isPro) return { allowed: true, isPro: true };
//   }
//   // Non-Pro users use device quota.
//   if (!deviceId) return { allowed: true };
//   const { data: row } = await supabaseAdmin
//     .from("extraction_usage")
//     .select("count, quota_total, period_start")
//     .eq("device_id", deviceId)
//     .maybeSingle();
//   if (!row) return { allowed: true, count: 0, quotaTotal: 10 };
//   const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
//   const periodStart = row.period_start
//     ? new Date(row.period_start).getTime()
//     : 0;
//   if (periodStart > 0 && Date.now() >= periodStart + WINDOW_MS) {
//     return {
//       allowed: true,
//       count: 0,
//       quotaTotal: row.quota_total ?? 10,
//       windowExpired: true,
//     };
//   }
//   const count = row.count ?? 0;
//   const quotaTotal = row.quota_total ?? 10;
//   return {
//     allowed: count < quotaTotal,
//     count,
//     quotaTotal,
//     remaining: Math.max(0, quotaTotal - count),
//   };
// }

const FREE_WEEKLY_QUOTA_NEW = 5; // fallback when no row yet (new user)

async function checkQuotaAllowed(deviceId, userId, rc_app_user_id) {
  if (!deviceId && !userId && !rc_app_user_id) return { allowed: true };

  const rcAppUserId = rc_app_user_id || userId;
  if (rcAppUserId) {
    const isPro = await isRevenueCatPro(rcAppUserId);
    if (isPro) return { allowed: true, isPro: true };
  }

  if (!deviceId) return { allowed: true };

  const { data: row } = await supabaseAdmin
    .from("extraction_usage")
    .select("count, quota_total, period_start")
    .eq("device_id", deviceId)
    .maybeSingle();

  // No row yet → new user will get quota_total = 5 on first import
  if (!row) {
    return { allowed: true, count: 0, quotaTotal: FREE_WEEKLY_QUOTA_NEW };
  }

  const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
  const periodStart = row.period_start
    ? new Date(row.period_start).getTime()
    : 0;

  if (periodStart > 0 && Date.now() >= periodStart + WINDOW_MS) {
    return {
      allowed: true,
      count: 0,
      quotaTotal: row.quota_total ?? FREE_WEEKLY_QUOTA_NEW,
      windowExpired: true,
    };
  }

  const count = row.count ?? 0;
  const quotaTotal = row.quota_total ?? FREE_WEEKLY_QUOTA_NEW;

  return {
    allowed: count < quotaTotal,
    count,
    quotaTotal,
    remaining: Math.max(0, quotaTotal - count),
  };
}

async function isRevenueCatPro(rcAppUserId) {
  if (!rcAppUserId || !REVENUECAT_SECRET_KEY) return false;
  const resp = await fetch(
    `https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(rcAppUserId)}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${REVENUECAT_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
    },
  );
  if (!resp.ok) {
    throw new Error(`RevenueCat check failed: ${resp.status}`);
  }
  const data = await resp.json();
  const entitlement = data?.subscriber?.entitlements?.[ENTITLEMENT_ID];
  if (!entitlement) return false;
  // Lifetime entitlement has null expires_date. Otherwise it must be in future.
  if (!entitlement.expires_date) return true;
  return new Date(entitlement.expires_date).getTime() > Date.now();
}

async function getInstagramCaptionAndThumbnail(url) {
  try {
    console.log("📸 Extracting Instagram data via Apify...");

    const run = await apifyClient.actor("apify/instagram-scraper").call({
      directUrls: [url],
      resultsType: "posts",
      resultsLimit: 1,
      addParentData: true,
    });

    const { items } = await apifyClient
      .dataset(run.defaultDatasetId)
      .listItems();

    if (items && items.length > 0) {
      const post = items[0];
      console.log("✅ Instagram data extracted successfully");

      let caption = post.caption || "";
      const ownerUsername = post.ownerUsername || "";

      const comments = post.latestComments || post.comments || [];
      const pinnedOrOwnerComment = comments.find(
        (c) =>
          c.isPinned ||
          c.ownerUsername === ownerUsername ||
          c.owner?.username === ownerUsername,
      );
      if (pinnedOrOwnerComment) {
        const commentText =
          pinnedOrOwnerComment.text || pinnedOrOwnerComment.body || "";
        if (commentText) {
          console.log("📌 Found pinned/owner comment, appending to caption");
          caption += "\n\n[Pinned Comment]:\n" + commentText;
        }
      }

      return {
        caption,
        thumbnail: post.displayUrl || post.thumbnailUrl || "",
        influencer: post.ownerFullName || ownerUsername,
      };
    }

    return { caption: "", thumbnail: "" };
  } catch (error) {
    console.error("❌ Instagram Apify extraction failed:", error.message);
    return { caption: "", thumbnail: "" };
  }
}

async function getYouTubeDescriptionAndThumbnail(url) {
  try {
    console.log("📺 Extracting YouTube data via Apify...");

    const run = await apifyClient.actor("streamers/youtube-scraper").call({
      startUrls: [{ url }],
      maxVideos: 1,
      maxResultsShorts: 0,
      scrapeComments: true,
      maxComments: 5,
    });

    const { items } = await apifyClient
      .dataset(run.defaultDatasetId)
      .listItems();

    if (items && items.length > 0) {
      const video = items[0];
      console.log("✅ YouTube data extracted successfully");

      const videoId = getYouTubeId(url);
      const fallbackThumbnail = videoId
        ? `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`
        : "";

      let caption =
        video.description ||
        video.descriptionText ||
        video.text ||
        video.snippet ||
        "";
      const channelName = video.channelName || video.channelTitle || "";

      const comments = video.comments || video.commentsList || [];
      const pinnedOrCreatorComment = comments.find(
        (c) =>
          c.isPinned ||
          c.pinnedBy ||
          c.authorChannelName === channelName ||
          c.author === channelName,
      );
      if (pinnedOrCreatorComment) {
        const commentText =
          pinnedOrCreatorComment.text || pinnedOrCreatorComment.content || "";
        if (commentText) {
          console.log(
            "📌 Found pinned/creator comment, appending to description",
          );
          caption += "\n\n[Pinned Comment]:\n" + commentText;
        }
      }

      return {
        caption,
        thumbnail: video.thumbnailUrl || fallbackThumbnail,
        influencer: channelName,
      };
    }

    const videoId = getYouTubeId(url);
    return {
      caption: "",
      thumbnail: videoId
        ? `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`
        : "",
    };
  } catch (error) {
    console.error("❌ YouTube Apify extraction failed:", error.message);
    const videoId = getYouTubeId(url);
    return {
      caption: "",
      thumbnail: videoId
        ? `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`
        : "",
    };
  }
}

async function getTikTokCaptionAndThumbnail(url) {
  try {
    console.log("🎵 Extracting TikTok data via Apify...");

    const run = await apifyClient.actor("clockworks/tiktok-scraper").call({
      postURLs: [url],
      resultsPerPage: 1,
      shouldDownloadComments: true,
      maxComments: 5,
    });

    const { items } = await apifyClient
      .dataset(run.defaultDatasetId)
      .listItems();

    if (items && items.length > 0) {
      const video = items[0];
      console.log("✅ TikTok data extracted successfully");

      let caption = video.text || "";
      const authorUsername = video.authorMeta?.name || "";

      const comments = video.comments || [];
      const pinnedOrCreatorComment = comments.find(
        (c) =>
          c.isPinned ||
          c.pinned ||
          c.user?.uniqueId === authorUsername ||
          c.uniqueId === authorUsername,
      );
      if (pinnedOrCreatorComment) {
        const commentText =
          pinnedOrCreatorComment.text || pinnedOrCreatorComment.comment || "";
        if (commentText) {
          console.log("📌 Found pinned/creator comment, appending to caption");
          caption += "\n\n[Pinned Comment]:\n" + commentText;
        }
      }

      return {
        caption,
        thumbnail: video.covers?.default || video.videoMeta?.coverUrl || "",
        influencer: video.authorMeta?.name || video.authorMeta?.nickName || "",
      };
    }

    return { caption: "", thumbnail: "" };
  } catch (error) {
    console.error("❌ TikTok Apify extraction failed:", error.message);
    return { caption: "", thumbnail: "" };
  }
}

app.post("/ocr", apiLimiter, upload.single("photo"), async (req, res) => {
  let processedPath = null;

  try {
    if (!req.file) {
      return res.status(400).json({
        error: "No file received",
      });
    }

    console.log("📸 File received:", req.file);

    const imagePath = req.file.path;
    const language = req.body.language || "en";

    // OCR.Space language mapping
    const ocrLanguageMap = {
      en: "eng",
      es: "spa",
      fr: "fre",
      de: "ger",
      pt: "por",
    };

    const ocrLanguage = ocrLanguageMap[language] || "eng";

    // OPTIONAL:
    // Improves Instagram/TikTok screenshot OCR quality
    // install sharp first:
    // npm install sharp

    const sharp = (await import("sharp")).default;

    processedPath = `${imagePath}-processed.jpg`;

    await sharp(imagePath)
      .resize({
        width: 1800,
        withoutEnlargement: true,
      })
      .normalize()
      .sharpen()
      .jpeg({ quality: 95 })
      .toFile(processedPath);

    // Create multipart form data
    const formData = new FormData();

    formData.append("file", fs.createReadStream(processedPath));

    formData.append("language", ocrLanguage);

    formData.append("isOverlayRequired", "false");

    formData.append("detectOrientation", "true");

    formData.append("scale", "true");

    formData.append("OCREngine", "2");

    console.log("🚀 Sending image to OCR.Space...");

    // OCR.Space request
    const response = await axios.post(
      "https://api.ocr.space/parse/image",
      formData,
      {
        headers: {
          apikey: process.env.OCR_SPACE_API_KEY,
          ...formData.getHeaders(),
        },
        maxBodyLength: Infinity,
      },
    );

    // Cleanup files
    if (fs.existsSync(imagePath)) {
      fs.unlinkSync(imagePath);
    }

    if (processedPath && fs.existsSync(processedPath)) {
      fs.unlinkSync(processedPath);
    }

    const parsedResults = response.data?.ParsedResults;

    if (!parsedResults || parsedResults.length === 0) {
      return res.status(200).json({
        extracted: "⚠️ No text found in image",
      });
    }

    // Merge OCR text
    const extractedText = parsedResults.map((r) => r.ParsedText).join("\n");

    console.log("📝 Extracted text:", extractedText);

    if (!extractedText.trim()) {
      return res.status(200).json({
        extracted: "⚠️ No text found in image",
      });
    }

    // Your existing AI recipe parser
    const structured = await processWithLLM(extractedText, language);

    return res.status(200).json({
      parsed: extractedText,
      structured,
    });
  } catch (err) {
    console.error("❌ OCR error:", err?.response?.data || err.message);

    // Cleanup files on error too
    try {
      if (req.file?.path && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }

      if (processedPath && fs.existsSync(processedPath)) {
        fs.unlinkSync(processedPath);
      }
    } catch (e) {}

    return res.status(500).json({
      error: "OCR processing failed",
      detail: err?.response?.data || err.message,
    });
  }
});

// app.post("/ocr", apiLimiter, upload.single("photo"), async (req, res) => {
//   try {
//     if (!req.file) return res.status(400).json({ error: "No file received" });
//     console.log("File received:", req.file);

//     const imagePath = req.file.path;
//     const language = req.body.language || "en"; // Extract language from form data

//     const tesseractLanguageMap = {
//       en: "eng",
//       es: "spa",
//       fr: "fra",
//       de: "deu",
//       pt: "por",
//     };

//     const tesseractLang = tesseractLanguageMap[language] || "eng";

//     const {
//       data: { text },
//     } = await Tesseract.recognize(imagePath, tesseractLang);

//     fs.unlinkSync(imagePath);

//     if (!text || text.trim() === "") {
//       return res.status(200).json({ extracted: "⚠️ No text found in image" });
//     }
//     console.log("Extracted text " + text);

//     const structured = await processWithLLM(text, language); // Pass language here
//     res.status(200).json({ parsed: text, structured });
//   } catch (err) {
//     console.error("OCR error:", err.message);
//     res
//       .status(500)
//       .json({ error: "OCR processing failed", detail: err.message });
//   }
// });

// ============ FOOD IMAGE SEARCH (TheMealDB → Pexels → Unsplash) ============

async function fetchFoodImage(foodName) {
  try {
    // 1. Try TheMealDB (free, no key needed)
    const mealDbRes = await fetch(
      `https://www.themealdb.com/api/json/v1/1/search.php?s=${encodeURIComponent(foodName)}`,
    );
    if (mealDbRes.ok) {
      const mealDbData = await mealDbRes.json();
      if (mealDbData.meals && mealDbData.meals.length > 0) {
        const img = mealDbData.meals[0].strMealThumb;
        if (img) {
          console.log(`✅ TheMealDB image found for: ${foodName}`);
          return img;
        }
      }
    }
  } catch (e) {
    console.log(`TheMealDB failed for ${foodName}:`, e.message);
  }

  try {
    // 2. Try Pexels (free, needs API key)
    const pexelsKey = process.env.PEXELS_API_KEY;
    if (pexelsKey) {
      const pexelsRes = await fetch(
        `https://api.pexels.com/v1/search?query=${encodeURIComponent(foodName)}+food&per_page=1&orientation=landscape`,
        { headers: { Authorization: pexelsKey } },
      );
      if (pexelsRes.ok) {
        const pexelsData = await pexelsRes.json();
        if (pexelsData.photos && pexelsData.photos.length > 0) {
          const img = pexelsData.photos[0].src.medium;
          if (img) {
            console.log(`✅ Pexels image found for: ${foodName}`);
            return img;
          }
        }
      }
    }
  } catch (e) {
    console.log(`Pexels failed for ${foodName}:`, e.message);
  }

  try {
    // 3. Fallback to Unsplash (already configured)
    const img = await fetchImageForRecipe(foodName);
    if (img) {
      console.log(`✅ Unsplash image found for: ${foodName}`);
      return img;
    }
  } catch (e) {
    console.log(`Unsplash failed for ${foodName}:`, e.message);
  }

  console.log(`❌ No image found for: ${foodName}`);
  return "";
}

// ============ VOICE-FIRST MACRO CALCULATION ============

const MACRO_PROMPT = `You are a nutrition expert AI assistant. The user will describe what they ate.

Your job:
1. Identify each food item and its portion
2. Calculate accurate calories (kcal) and macronutrients (protein, carbs, fat in grams)
3. Return ONLY valid JSON (no markdown, no code fences)

Response format:
{
  "items": [
    {
      "name": "Chole Bhature",
      "quantity": "1 plate",
      "weight_grams": 300,
      "calories": 450,
      "protein": 12,
      "carbs": 55,
      "fat": 20
    }
  ],
  "total": {
    "calories": 450,
    "protein": 12,
    "carbs": 55,
    "fat": 20
  },
  "summary": "A brief friendly one-line summary of the analysis"
}

Rules:
- If user mentions multiple items, list each separately in "items" and sum them in "total"
- All macro values in grams (calories in kcal)
- "weight_grams" is REQUIRED and MUST be a number - the estimated weight in grams (e.g. 1 plate of biryani = 350, 1 glass of lassi = 250, 1 glass of milk = 200, 1 roti = 40, 1 egg = 50)
- If user says "200ml of milk", weight_grams should be 200
- Use realistic nutritional values based on standard serving sizes
- If user does NOT specify a quantity, assume 1 standard serving and estimate weight_grams accordingly
- calories, protein, carbs, fat should be the TOTAL macros for the specified weight_grams amount
- "a plate", "a bowl", "a glass", "a piece" — estimate standard Indian/international portions
- "quantity" should be human-readable (e.g. "1 plate", "2 pieces", "1 bowl")
- The user may speak in ANY language (Hindi, Tamil, Kannada, Telugu, Marathi, Spanish, French, German, etc.) — understand the food items regardless of language and return item names in English
- If the input is not food-related or unclear, return: {"error": "I couldn't identify any food items. Could you describe what you ate?"}
- ONLY return valid JSON, no markdown, no extra text`;

// Text-based macro calculation
app.post("/nutrition/text", apiLimiter, async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: "text is required" });

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: MACRO_PROMPT },
        { role: "user", content: `I ate: ${text}` },
      ],
      temperature: 0.3,
      response_format: { type: "json_object" },
    });

    const content = response.choices[0].message.content;
    if (!content) return res.status(500).json({ error: "Empty AI response" });

    const result = JSON.parse(content);

    // Fetch images for each item in parallel
    if (result.items && result.items.length > 0) {
      const imagePromises = result.items.map((item) =>
        fetchFoodImage(item.name),
      );
      const images = await Promise.all(imagePromises);
      result.items.forEach((item, idx) => {
        item.imageUrl = images[idx] || "";
      });
    }

    return res.status(200).json(result);
  } catch (error) {
    console.error("Nutrition text error:", error);
    return res.status(500).json({ error: "Failed to process nutrition data" });
  }
});

app.post(
  "/nutrition/audio",
  apiLimiter,
  memUpload.single("audio"),
  async (req, res) => {
    let tempPath = null;
    try {
      if (!req.file)
        return res.status(400).json({ error: "audio file is required" });

      tempPath = path.join(os.tmpdir(), `${Date.now()}.m4a`);
      fs.writeFileSync(tempPath, req.file.buffer);

      const transcription = await openai.audio.transcriptions.create({
        file: fs.createReadStream(tempPath),
        model: "whisper-1",
      });

      fs.unlinkSync(tempPath);
      tempPath = null;

      if (!transcription.text || transcription.text.trim().length === 0) {
        return res.status(200).json({
          items: [],
          total: { calories: 0, protein: 0, carbs: 0, fat: 0 },
          summary: "",
          error: "Could not understand the audio. Please try again.",
        });
      }

      console.log("Whisper transcription:", transcription.text);

      const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: MACRO_PROMPT },
          { role: "user", content: `I ate: ${transcription.text}` },
        ],
        temperature: 0.3,
        response_format: { type: "json_object" },
      });

      const content = response.choices[0].message.content;
      if (!content) return res.status(500).json({ error: "Empty AI response" });

      const result = JSON.parse(content);
      result.transcription = transcription.text;

      // Fetch images for each item in parallel
      if (result.items && result.items.length > 0) {
        const imagePromises = result.items.map((item) =>
          fetchFoodImage(item.name),
        );
        const images = await Promise.all(imagePromises);
        result.items.forEach((item, idx) => {
          item.imageUrl = images[idx] || "";
        });
      }

      return res.status(200).json(result);
    } catch (error) {
      console.error("Nutrition audio error:", error);
      if (tempPath) {
        try {
          fs.unlinkSync(tempPath);
        } catch (e) {}
      }
      return res.status(500).json({ error: "Failed to process audio" });
    }
  },
);

app.post("/nutrition-estimate", apiLimiter, async (req, res) => {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    const {
      id,
      title,
      ingredientsForApi,
      servingsForApi,
      language = "en",
    } = req.body;
    console.log("nutrition-estimate", req.body);

    if (
      !title ||
      !ingredientsForApi ||
      !Array.isArray(ingredientsForApi) ||
      ingredientsForApi.length === 0 ||
      servingsForApi == null
    ) {
      console.log("❌ Invalid request:", req.body);
      return res.status(400).json({
        error: "Recipe title, ingredients, and serving size are required",
      });
    }

    // 1️⃣ Ask OpenAI for 100g portion only
    const languageMap = {
      en: "English",
      fr: "French",
      de: "German",
      pt: "Portuguese",
      es: "Spanish",
    };

    const languageName = languageMap[language] || "English";

    const prompt = `You are a nutrition analysis expert.

Your task is to calculate accurate nutritional values for a recipe based on its ingredients and serving size.

IMPORTANT: All user-facing text (like warnings) must be in ${languageName} language.
Do NOT translate JSON keys. Only translate text values.

INPUT:
- Recipe ID: ${id}
- Recipe Title: ${title}
- Ingredients: ${ingredientsForApi}
- Serving Size: ${servingsForApi}

INSTRUCTIONS:
1. Identify and ignore any non-food items (e.g., plastic, foil, toothpick, packaging, wrapper).
2. If any non-food items are found, add a warning message in ${languageName}.
3. Estimate total nutrition for ONLY valid food ingredients.
4. Then calculate PER SERVING values using the given serving size.
5. Use standard nutritional assumptions when exact values are unknown.
6. Return ONLY valid JSON (no explanation, no extra text).
7. All numeric values must be numbers (no strings, no units).
8. Units:
   - calories → kcal
   - protein, carbs, fat, fiber → grams
   - iron, calcium, vitaminC, potassium → mg
   - vitaminA → mcg
9. Round all values to 1 decimal place.
10. Ensure all values are >= 0.
11. Always include the "warnings" field (empty array if none).

OUTPUT FORMAT:
{
  "calories": number,
  "protein": number,
  "carbs": number,
  "fat": number,
  "fiber": number,
  "micronutrients": {
    "iron": number,
    "calcium": number,
    "vitaminA": number,
    "vitaminC": number,
    "potassium": number
  },
  "warnings": string[]
}`;

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-3.5-turbo",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 500,
        temperature: 0.1,
      }),
    });
    console.log("nutrition-estimate response:", response);

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content?.trim();

    if (!text) throw new Error("OpenAI response did not contain text");

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON found in OpenAI response");

    let result = JSON.parse(jsonMatch[0]);
    console.log("nutrition-estimate result:", result);

    return res.status(200).json(result);
  } catch (error) {
    console.error("OpenAI API error:", error);
    return res.status(500).json({ error: "Failed to process nutrition data" });
  }
});

const fetchImageForRecipe = async (recipeName) => {
  const res = await fetch(
    `https://api.unsplash.com/search/photos?query=${encodeURIComponent(
      recipeName,
    )}%20food&per_page=1`,
    {
      headers: {
        Authorization: `Client-ID ${process.env.UNSPLASH_ACCESS_KEY}`,
      },
    },
  );

  if (!res.ok) {
    console.error("Unsplash error:", res.status);
    return "";
  }

  const data = await res.json();
  const image = data.results?.[0]?.urls?.regular; // ✅ usable in RN
  return image ?? "";
};

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Server running on port ${PORT}`);
});
