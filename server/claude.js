import { spawn } from 'node:child_process';

export function callClaude({ system, user, timeoutMs = 60_000 }) {
  return new Promise((resolve, reject) => {
    const model = process.env.CLAUDE_MODEL || 'opus';
    const args = ['--print', '--output-format', 'json', '--model', model];
    if (system) args.push('--system-prompt', system);

    const proc = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`claude subprocess timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.stdout.on('data', (d) => (stdout += d));
    proc.stderr.on('data', (d) => (stderr += d));

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`failed to spawn claude: ${err.message}`));
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        return reject(new Error(`claude exited ${code}: ${stderr || stdout}`));
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`could not parse claude json output: ${stdout.slice(0, 300)}`));
      }
    });

    proc.stdin.write(user ?? '');
    proc.stdin.end();
  });
}

export function parseDJResponse(text) {
  if (typeof text !== 'string') text = String(text ?? '');

  const say = extractTag(text, 'say');
  const playBlock = extractTag(text, 'play');
  const reason = extractTag(text, 'reason');
  const segue = extractTag(text, 'segue');

  if (say == null && playBlock == null) {
    return { say: text.trim(), play: [], reason: 'unparsed', segue: null };
  }

  const play = (playBlock || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((query) => ({ query }));

  return {
    say: (say || '').trim(),
    play,
    reason: (reason || '').trim(),
    segue: segue ? segue.trim() : null,
  };
}

function extractTag(text, tag) {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i');
  const m = text.match(re);
  return m ? m[1] : null;
}
