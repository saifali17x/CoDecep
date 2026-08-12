// Tiny fetch helper so pages don't repeat headers/JSON/error boilerplate.
// The base URL comes from lib/config.js (gap #61) — unset VITE_API_URL still
// resolves to http://localhost:3001, exactly as this constant used to.
import { API_BASE } from "./config";

const BASE = API_BASE;

// apiFetch(path, { method, body, token })
// - JSON body is stringified + Content-Type set automatically.
// - FormData body is sent as-is (browser sets multipart boundary).
// - Bearer token added when provided.
// - Throws Error(server message) on non-2xx.
export async function apiFetch(path, { method = "GET", body, token } = {}) {
  const headers = {};
  let payload = body;

  const isFormData = typeof FormData !== "undefined" && body instanceof FormData;
  if (body !== undefined && !isFormData) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${BASE}${path}`, { method, headers, body: payload });

  // 204/empty guard
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;

  if (!res.ok) {
    const message = data?.error ?? `Request failed — HTTP ${res.status}`;
    const err = new Error(message);
    // Field-level validation errors from the backend's 400 response
    // ([{ field, message }]) — forms map these to the right inputs.
    err.details = data?.details;
    err.status = res.status;
    throw err;
  }
  return data;
}

export { BASE };
