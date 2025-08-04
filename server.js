const express = require("express");
const multer = require("multer");
const fs = require("fs");
const cors = require("cors");
const Tesseract = require("tesseract.js");
const puppeteer = require("puppeteer");
const {
  GoogleGenerativeAI,
  HarmBlockThreshold,
  HarmCategory,
} = require("@google/generative-ai");

require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());
const upload = multer({ dest: "uploads/" });
app.use(express.json());

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
const path = require("path");
const axios = require("axios");

const AZURE_ENDPOINT =
  "https://imageextractsnapcook.cognitiveservices.azure.com/"; // e.g. https://<your-resource-name>.cognitiveservices.azure.com/
const AZURE_KEY = process.env.AZURE_VISION_KEY;
console.log("🔍 AZURE_VISION_KEY:", AZURE_KEY ? "SET" : "NOT SET");

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
console.log("🔍 GEMINI_API_KEY:", GEMINI_API_KEY ? "SET" : "NOT SET");

if (!AZURE_KEY) {
  console.error("❌ Missing AZURE_VISION_KEY in environment variables");
  console.error(
    "💡 Please set AZURE_VISION_KEY in Railway environment variables"
  );
  // Don't exit immediately, let the server start for debugging
}

if (!GEMINI_API_KEY) {
  console.error("❌ Missing GEMINI_API_KEY in environment variables");
  console.error(
    "💡 Please set GEMINI_API_KEY in Railway environment variables"
  );
  // Don't exit immediately, let the server start for debugging
}
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

async function processWithLLM(inputText) {
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

  const result = await model.generateContent({
    contents: [
      {
        role: "user",
        parts: [
          {
            text: `You are a helpful assistant that extracts recipe information from given text and return only structured JSON with:
- title
- ingredients (list of strings)
- instructions (list of strings, where each string is a detailed step)
- nutritional_info (estimated: total_calories, protein, carbs, fat)
- cooking_time (if present)
- serving_size (if present)
- influencer (if present)

Text: ${inputText}`,
          },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          ingredients: { type: "array", items: { type: "string" } },
          instructions: { type: "array", items: { type: "string" } },
          influencer: { type: "string" },
          nutritional_info: {
            type: "object",
            properties: {
              total_calories: { type: "string" },
              protein: { type: "string" },
              carbs: { type: "string" },
              fat: { type: "string" },
            },
          },
          cooking_time: { type: "string" },
          serving_size: { type: "string" },
        },
        required: ["title", "ingredients", "instructions"],
      },
    },
    safetySettings: [
      {
        category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
        threshold: HarmBlockThreshold.BLOCK_NONE,
      },
      {
        category: HarmCategory.HARM_CATEGORY_HARASSMENT,
        threshold: HarmBlockThreshold.BLOCK_NONE,
      },
      {
        category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
        threshold: HarmBlockThreshold.BLOCK_NONE,
      },
      {
        category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
        threshold: HarmBlockThreshold.BLOCK_NONE,
      },
    ],
  });

  const response = await result.response;
  return JSON.parse(response.text());
}

async function getInstagramCaption(url) {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: "networkidle2", timeout: 0 });

  const caption = await page.$eval(
    "meta[property='og:description']",
    (el) => el.content
  );
  await browser.close();
  return caption;
}

async function getYouTubeDescription(url) {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: "networkidle2", timeout: 0 });

  const caption = await page.$eval(
    "meta[name='description']",
    (el) => el.content
  );
  await browser.close();
  return caption;
}

async function getInstagramCaptionAndThumbnail(url) {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: "networkidle2", timeout: 0 });

  const caption = await page.$eval(
    "meta[property='og:description']",
    (el) => el.content
  );
  const thumbnail = await page.$eval(
    "meta[property='og:image']",
    (el) => el.content
  );
  await browser.close();
  return { caption, thumbnail };
}

function getYouTubeId(url) {
  const match = url.match(
    /(?:youtube\.com\/(?:[^\/\n\s]+\/\S+\/|(?:v|e(?:mbed)?|shorts)\/|.*[?&]v=)|youtu\.be\/)([\w-]{11})/
  );
  return match ? match[1] : null;
}

async function getYouTubeDescriptionAndThumbnail(url) {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: "networkidle2", timeout: 0 });

  const caption = await page.$eval(
    "meta[name='description']",
    (el) => el.content
  );
  await browser.close();

  const videoId = getYouTubeId(url);
  const thumbnail = videoId
    ? `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`
    : null;

  return { caption, thumbnail };
}

// app.post("/url-scan", async (req, res) => {
//   const { url } = req.body;
//   if (!url) return res.status(400).json({ error: "URL is required" });

//   let captionText = "";

//   try {
//     if (url.includes("instagram.com")) {
//       captionText = await getInstagramCaption(url);
//     } else if (url.includes("youtube.com") || url.includes("youtu.be")) {
//       captionText = await getYouTubeDescription(url);
//     }

//     if (!captionText)
//       return res.status(404).json({ error: "No caption found" });

//     const structured = await processWithLLM(captionText);
//     res.status(200).json({ structured });
//   } catch (error) {
//     console.error("URL Processing Error:", error);
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

    if (url.includes("instagram.com")) {
      const result = await getInstagramCaptionAndThumbnail(url);
      captionText = result.caption;
      thumbnail = result.thumbnail;
    } else if (url.includes("youtube.com") || url.includes("youtu.be")) {
      const result = await getYouTubeDescriptionAndThumbnail(url);
      captionText = result.caption;
      thumbnail = result.thumbnail;
    }

    if (!captionText)
      return res.status(404).json({ error: "No caption found" });

    const structured = await processWithLLM(captionText);

    // Attach thumbnail to structured result
    if (structured && typeof structured === "object") {
      structured.image = thumbnail;
    }

    res.status(200).json({ structured, thumbnail });
  } catch (error) {
    console.error("URL Extraction Error:", error);
    res
      .status(500)
      .json({ error: "Failed to process URL", detail: error.message });
  }
});

app.post("/ocr", upload.single("photo"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file received" });
    console.log("File received:", req.file);

    const imagePath = path.join(__dirname, req.file.path);
    const imageData = fs.readFileSync(imagePath);

    const response = await axios.post(
      `${AZURE_ENDPOINT}/vision/v3.2/ocr?language=unk&detectOrientation=true`,
      imageData,
      {
        headers: {
          "Ocp-Apim-Subscription-Key": AZURE_KEY,
          "Content-Type": "application/octet-stream",
        },
      }
    );

    // const imagePath = req.file.path;
    // const {
    //   data: { text },
    // } = await Tesseract.recognize(imagePath, "eng");
    fs.unlinkSync(imagePath);

    // Parse Azure OCR response
    const lines = [];
    const regions = response.data.regions || [];
    for (const region of regions) {
      for (const line of region.lines) {
        lines.push(line.words.map((w) => w.text).join(" "));
      }
    }
    const text = lines.join("\n");

    if (!text || text.trim() === "") {
      return res.status(200).json({ extracted: "⚠️ No text found in image" });
    }
    console.log("Extracted text " + text);

    const structured = await processWithLLM(text);
    res.status(200).json({ parsed: text, structured });
  } catch (err) {
    console.error(
      "Azure error:",
      err.response ? err.response.data : err.message
    );
    res
      .status(500)
      .json({ error: "OCR processing failed", detail: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
