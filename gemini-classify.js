const fetch = require('node-fetch');

// Shared by categorize.js and classify-type.js: both send a batch of
// transactions to Gemini and expect back a JSON array of
// {entry_reference, <resultKey>} constrained to resultEnum. Only the prompt
// text and the enum differ between the two call sites.
async function classifyWithGemini({ prompt, resultKey, resultEnum, apiKey, model }) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                entry_reference: { type: 'STRING' },
                [resultKey]: { type: 'STRING', enum: resultEnum },
              },
              required: ['entry_reference', resultKey],
            },
          },
        },
      }),
    },
  );

  if (!res.ok) throw new Error(`Gemini API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error(`Unexpected Gemini response: ${JSON.stringify(data)}`);
  return JSON.parse(text);
}

module.exports = { classifyWithGemini };
