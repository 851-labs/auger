const ADJECTIVES = [
  'brave',
  'calm',
  'clever',
  'crisp',
  'bright',
  'mellow',
  'quick',
  'witty',
  'sly',
  'kind',
  'swift',
  'bold',
];

const NOUNS = [
  'pickle',
  'tiger',
  'otter',
  'panda',
  'comet',
  'ember',
  'falcon',
  'grove',
  'harbor',
  'meadow',
  'rocket',
  'willow',
];

function defaultRandom(): number {
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  return buffer[0] / 0xffffffff;
}

export function generateSubdomain(randomFn: () => number = defaultRandom): string {
  const adj = ADJECTIVES[Math.floor(randomFn() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(randomFn() * NOUNS.length)];
  return `${adj}-${noun}`;
}
