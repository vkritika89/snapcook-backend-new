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
import {
  GoogleGenerativeAI,
  HarmBlockThreshold,
  HarmCategory,
} from "@google/generative-ai";

dotenv.config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY, // set your key in .env
});

const app = express();
app.use(cors());
app.use(express.json());
const upload = multer({ dest: "uploads/" });

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
  const systemPrompt = `You are a helpful assistant that extracts recipe information from given text and returns only valid JSON with the following structure:
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
- Each instruction step should be a complete detailed sentence.`;

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
