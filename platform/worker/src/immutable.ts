// Immutable copies of retained measurement and decision evidence.
export function immutable<Value>(value: Value): Value {
  const copy = structuredClone(value);
  const freeze = (part: any) => {
    if (part && typeof part === 'object') {
      for (const child of Object.values(part)) freeze(child);
      Object.freeze(part);
    }
  };
  freeze(copy);
  return copy;
}
