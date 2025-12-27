import express from "express";
import multer from "multer";
import fs from "fs";
import cors from "cors";
import Tesseract from "tesseract.js";
import puppeteer from "puppeteer";
import OpenAI from "openai";
import dotenv from "dotenv";
import path from "path";
import axios from "axios";
import { ApifyClient } from "apify-client";
import {
  GoogleGenerativeAI,
  HarmBlockThreshold,
  HarmCategory,
} from "@google/generative-ai";

dotenv.config();

const apifyClient = new ApifyClient({
  token: process.env.APIFY_TOKEN,
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY, // set your key in .env
});

const app = express();
app.use(cors());
app.use(express.json());
const upload = multer({ dest: "uploads/" });
const client = new OpenAI();

// Health check endpoint
app.get("/", (req, res) => {
  res.json({
    status: "OK",
    message: "SnapCook Backend is running!",
    timestamp: new Date().toISOString(),
    environment: {
      azure_key_set: !!process.env.AZURE_VISION_KEY,
      gemini_key_set: !!process.env.GEMINI_API_KEY,
    },
  });
});

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
console.log("🔍 GEMINI_API_KEY:", GEMINI_API_KEY ? "SET" : "NOT SET");

if (!GEMINI_API_KEY) {
  console.error("❌ Missing GEMINI_API_KEY in environment variables");
  console.error(
    "💡 Please set GEMINI_API_KEY in Railway environment variables"
  );
}

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

export async function processWithLLM(inputText) {
  const systemPrompt = `You are a helpful assistant that extracts recipe information from given text if present and returns only valid JSON with the following structure:
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
- If any field is not present, leave it empty ("" or empty object/array).
- Each instruction step should be a complete detailed sentence.
- Estimate total_calories, protein, carbs, and fat based on the ingredients and their mentioned quantities.
- Return approximate values for the entire recipe (not per 100g).
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

// export async function processWithLLM(inputText) {
//   const systemPrompt = `
// You are a helpful assistant that extracts recipe information from given text if present and returns only valid JSON with the following strict structure:

// {
//   "title": "",
//   "ingredients": [],
//   "instructions": [],
//   "influencer": "",
//   "nutritional_info": {
//     "total_calories": "",
//     "protein": "",
//     "carbs": "",
//     "fat": ""
//   },
//   "cooking_time": "",
//   "serving_size": ""
// }

// Rules:
// - Always return ONLY valid JSON.
// - Never include explanations.
// - If a field is missing, return an empty string or empty array.
// - Each instruction step must be a clear, complete sentence.
// - Estimate total recipe calories + macros based on mentioned ingredients.
// - Never include trailing commas.
// `;

//   const userPrompt = `Text: ${inputText}`;

//   const response = await client.responses.create({
//     model: "gpt-5.1-mini",
//     input: [
//       { role: "system", content: systemPrompt },
//       { role: "user", content: userPrompt },
//     ],
//     temperature: 0,
//     text: {
//       format: { type: "json" },
//     },
//   });

//   const jsonText = response.output_text;

//   return JSON.parse(jsonText);
// }

// async function getInstagramCaptionAndThumbnail(url) {
//   const browser = await puppeteer.launch({
//     headless: "new",
//     args: ["--no-sandbox"],
//   });
//   const page = await browser.newPage();
//   await page.goto(url, { waitUntil: "networkidle2", timeout: 0 });

//   const caption = await page.$eval(
//     "meta[property='og:description']",
//     (el) => el.content
//   );
//   const thumbnail = await page.$eval(
//     "meta[property='og:image']",
//     (el) => el.content
//   );
//   await browser.close();
//   return { caption, thumbnail };
// }

function getYouTubeId(url) {
  const match = url.match(
    /(?:youtube\.com\/(?:[^\/\n\s]+\/\S+\/|(?:v|e(?:mbed)?|shorts)\/|.*[?&]v=)|youtu\.be\/)([\w-]{11})/
  );
  return match ? match[1] : null;
}

// async function getYouTubeDescriptionAndThumbnail(url) {
//   const browser = await puppeteer.launch({
//     headless: "new",
//     args: ["--no-sandbox"],
//   });
//   const page = await browser.newPage();
//   await page.goto(url, { waitUntil: "networkidle2", timeout: 0 });

//   const caption = await page.$eval(
//     "meta[name='description']",
//     (el) => el.content
//   );
//   await browser.close();

//   const videoId = getYouTubeId(url);
//   const thumbnail = videoId
//     ? `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`
//     : null;

//   return { caption, thumbnail };
// }

// app.post("/url-extract", async (req, res) => {
//   const { url } = req.body;
//   if (!url) return res.status(400).json({ error: "URL is required" });

//   try {
//     let captionText = "";
//     let thumbnail = "";

//     if (url.includes("instagram.com")) {
//       const result = await getInstagramCaptionAndThumbnail(url);
//       captionText = result.caption;
//       thumbnail = result.thumbnail;
//     } else if (url.includes("youtube.com") || url.includes("youtu.be")) {
//       const result = await getYouTubeDescriptionAndThumbnail(url);
//       captionText = result.caption;
//       thumbnail = result.thumbnail;
//     }

//     if (!captionText)
//       return res.status(404).json({ error: "No caption found" });

//     const structured = await processWithLLM(captionText);

//     if (structured && typeof structured === "object") {
//       structured.image = thumbnail;
//     }

//     res.status(200).json({ structured, thumbnail });
//   } catch (error) {
//     console.error("URL Extraction Error:", error);
//     res
//       .status(500)
//       .json({ error: "Failed to process URL", detail: error.message });
//   }
// });

app.post("/url-extract", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "URL is required" });

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

    const structured = await processWithLLM(captionText);

    if (structured && typeof structured === "object") {
      structured.image = thumbnail;
      if (influencer && !structured.influencer) {
        structured.influencer = influencer;
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

// ============ REPLACE YOUR PUPPETEER FUNCTIONS WITH THESE ============

async function getInstagramCaptionAndThumbnail(url) {
  try {
    console.log("📸 Extracting Instagram data via Apify...");

    // Run Instagram scraper
    const run = await apifyClient.actor("apify/instagram-scraper").call({
      directUrls: [url],
      resultsType: "posts",
      resultsLimit: 1,
    });

    // Get results from dataset
    const { items } = await apifyClient
      .dataset(run.defaultDatasetId)
      .listItems();

    if (items && items.length > 0) {
      const post = items[0];
      console.log("✅ Instagram data extracted successfully");

      return {
        caption: post.caption || "",
        thumbnail: post.displayUrl || post.thumbnailUrl || "",
        influencer: post.ownerFullName || post.ownerUsername || "",
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

    // Run YouTube scraper
    const run = await apifyClient.actor("streamers/youtube-scraper").call({
      startUrls: [{ url }],
      maxResults: 1,
      maxResultsShorts: 1,
    });

    // Get results from dataset
    const { items } = await apifyClient
      .dataset(run.defaultDatasetId)
      .listItems();

    if (items && items.length > 0) {
      const video = items[0];
      console.log("✅ YouTube data extracted successfully");

      // Get video ID for thumbnail fallback
      const videoId = getYouTubeId(url);
      const fallbackThumbnail = videoId
        ? `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`
        : "";

      return {
        caption: video.description || video.text || "",
        thumbnail: video.thumbnailUrl || fallbackThumbnail,
        influencer: video.channelName || video.channelTitle || "",
      };
    }

    // Fallback to thumbnail from video ID
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

// NEW: Add TikTok support
async function getTikTokCaptionAndThumbnail(url) {
  try {
    console.log("🎵 Extracting TikTok data via Apify...");

    // Run TikTok scraper
    const run = await apifyClient.actor("clockworks/tiktok-scraper").call({
      postURLs: [url],
      resultsPerPage: 1,
    });

    // Get results from dataset
    const { items } = await apifyClient
      .dataset(run.defaultDatasetId)
      .listItems();

    if (items && items.length > 0) {
      const video = items[0];
      console.log("✅ TikTok data extracted successfully");

      return {
        caption: video.text || "",
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

app.post("/ocr", upload.single("photo"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file received" });
    console.log("File received:", req.file);

    const imagePath = req.file.path;

    const {
      data: { text },
    } = await Tesseract.recognize(imagePath, "eng");

    fs.unlinkSync(imagePath);

    if (!text || text.trim() === "") {
      return res.status(200).json({ extracted: "⚠️ No text found in image" });
    }
    console.log("Extracted text " + text);

    const structured = await processWithLLM(text);
    res.status(200).json({ parsed: text, structured });
  } catch (err) {
    console.error("OCR error:", err.message);
    res
      .status(500)
      .json({ error: "OCR processing failed", detail: err.message });
  }
});

app.post("/nutrition", async (req, res) => {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    const { recipeName, quantity } = req.body;

    if (!recipeName || !quantity) {
      return res
        .status(400)
        .json({ error: "recipeName and quantity are required" });
    }

    // 1️⃣ Ask OpenAI for 100g portion only
    const prompt = `You are a nutrition expert. Analyze if "${recipeName}" is a valid food item or recipe name.

IMPORTANT RULES:
1. If the input is NOT a real food item, recipe, or edible item, return:
{
  "total": { "calories": 0, "protein": 0, "carbs": 0, "fat": 0 },
  "ingredients": [],
  "imageUrl": ""
}

2. If it IS a real food/recipe, give nutritional breakdown for exactly 100g portion only:

{
  "total": { "calories": X, "protein": X, "carbs": X, "fat": X },
  "ingredients": [
    { "name": "ingredient1", "calories": X, "protein": X, "carbs": X, "fat": X },
    { "name": "ingredient2", "calories": X, "protein": X, "carbs": X, "fat": X }
  ]
}

3. Return valid JSON only. All values must be numbers (not strings).
4. Include a realistic imageUrl if available. Otherwise, set it to an empty string.`;

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

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content?.trim();

    if (!text) throw new Error("OpenAI response did not contain text");

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON found in OpenAI response");

    let result = JSON.parse(jsonMatch[0]);

    // 2️⃣ Scale to requested quantity
    const factor = quantity / 100;

    const scaleNutrition = (item) => ({
      calories: +(item.calories * factor).toFixed(1),
      protein: +(item.protein * factor).toFixed(1),
      carbs: +(item.carbs * factor).toFixed(1),
      fat: +(item.fat * factor).toFixed(1),
    });

    result.total = scaleNutrition(result.total);
    result.ingredients = result.ingredients.map(scaleNutrition);

    // 3️⃣ Optionally override imageUrl using your own fetchImageForRecipe()
    const imageUrl = await fetchImageForRecipe(recipeName);
    result.imageUrl = imageUrl || result.imageUrl || "";

    return res.status(200).json(result);
  } catch (error) {
    console.error("OpenAI API error:", error);
    return res.status(500).json({ error: "Failed to process nutrition data" });
  }
});

const fetchImageForRecipe = async (recipeName) => {
  const res = await fetch(
    `https://api.unsplash.com/search/photos?query=${encodeURIComponent(
      recipeName
    )}%20food&per_page=1`,
    {
      headers: {
        Authorization: `Client-ID ${process.env.UNSPLASH_ACCESS_KEY}`,
      },
    }
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
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
