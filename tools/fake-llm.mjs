import http from 'node:http';
// Stands in for Groq's OpenAI-compatible Chat Completions API. Returns a valid-shaped
// response containing one legitimate finding, one on a line that was never added
// (hallucination), and one in a file that is not in the diff. Only the legitimate one
// may survive the validation gate.
const body = JSON.stringify([
  { path: 'src/x.js', line: 1, severity: 'critical', category: 'security', title: 'eval of user input' },
  { path: 'src/x.js', line: 999, severity: 'high', category: 'security', title: 'HALLUCINATED line' },
  { path: 'other/nope.js', line: 1, severity: 'low', category: 'style', title: 'HALLUCINATED file' },
  { path: 'src/x.js', line: 2, severity: 'not-a-severity', category: 'nonsense', title: '' },
]);
http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    console.log('prompt bytes received:', raw.length, 'path:', req.url);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: body } }] }));
  });
}).listen(9500, () => console.log('fake groq listening on 9500'));
