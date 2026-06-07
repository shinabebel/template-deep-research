import 'dotenv/config';

// Central model configuration shared by every agent in this project.
// Switch the whole app to a different model by editing .env — no code changes.
//
// Local Ollama: set both vars, pointing MODEL_BASE_URL at Ollama's
// OpenAI-compatible base URL — note the trailing /v1, NOT the /api/chat endpoint:
//   MODEL=ollama/gemma4:e4b-16k
//   MODEL_BASE_URL=http://localhost:11434/v1
//
// Hosted provider (OpenAI / Anthropic / Google / ...): set MODEL only, leave
// MODEL_BASE_URL empty, and the matching API key in .env is used automatically.

// Mastra's model router types the id as `provider/model`, so assert that shape.
const id = (process.env.MODEL || 'ollama/gemma4:e4b-16k') as `${string}/${string}`;
const url = process.env.MODEL_BASE_URL?.trim();

// With an explicit `url`, Mastra treats the endpoint as OpenAI-compatible and
// ignores the provider prefix's default host. Ollama ignores the key, but the
// OpenAI client requires a non-empty string, so we pass a placeholder.
export const model = url
  ? { id, url, apiKey: process.env.MODEL_API_KEY || 'ollama' }
  : id;
