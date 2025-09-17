import { GoogleGenerativeAI } from "@google/generative-ai";
import { config } from './config.js';

const genAI = new GoogleGenerativeAI(config.geminiApiKey);
const model = () => genAI.getGenerativeModel({ model: config.geminiModel });

export async function generateAnswer(prompt) {
  const result = await model().generateContent(prompt);
  return result.response.text();
}

export async function *streamAnswer(prompt) {
  const stream = await model().generateContentStream(prompt);
  for await (const chunk of stream.stream) {
    const t = chunk.text();
    if (t) yield t;
  }
}
