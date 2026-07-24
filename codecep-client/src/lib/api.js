// Tiny fetch helper so pages don't repeat headers/JSON/error boilerplate.
const BASE = "http://localhost:3001";

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
    throw new Error(message);
  }
  return data;
}

export { BASE };
