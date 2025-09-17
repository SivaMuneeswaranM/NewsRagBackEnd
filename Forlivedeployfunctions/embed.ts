// frontend/src/api/embed.ts
export async function embedServer(input: string | string[]) {
  const r = await fetch('/embed', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(text || `Embed server ${r.status}`);
  const { vectors } = JSON.parse(text);
  return vectors as number[][];
}
