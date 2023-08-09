// returns the next string if matches the given matcher,
// otherwise returns null
// consumes the line from the lines array
export const consumeNextMatching = (lines: string[], matcher: RegExp) => {
  while (lines.length > 0) {
    const line = (lines.shift() as string).trim();
    if (line === '') {
      continue;
    }
    if (matcher.test(line)) {
      return line;
    }
    return null;
  }
  return null;
};

// returns strings if next non-empty line matches the given matcher,
// otherwise returns empty array
// consumes the lines from the lines array
export const consumeBlockIfMatches = (lines: string[], matcher: RegExp) => {
  const result = [] as string[];
  if (lines.length === 0) {
    return result;
  }

  let line = lines.shift() as string;

  while (line.trim() === '') {
    line = lines.shift() as string;
  }
  if (!matcher.test(line)) {
    lines.unshift(line);
    return result;
  }
  result.push(line);
  while (lines.length > 0) {
    line = lines.shift() as string;
    if (line.trim() === '') {
      break;
    }
    result.push(line);
  }
  return result;
};

export const splitColumns = (line: string) => line.trim().split(/\s{2,}/);

export const drawPointer = (width: number) => {
  const result = [] as string[];
  result.push('└');
  for (let i = 0; i < width - 4; i++) {
    result.push('─');
  }
  result.push('>');
  return result.join('');
};
