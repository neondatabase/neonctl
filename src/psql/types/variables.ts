export type PsqlVar = {
  name: string;
  value: string;
};

export type VarHook = (newValue: string | null) => boolean;

export type VarStore = {
  set(name: string, value: string): boolean;
  get(name: string): string | undefined;
  unset(name: string): boolean;
  has(name: string): boolean;
  addHook(name: string, hook: VarHook): void;
  entries(): IterableIterator<[string, string]>;
  asBool(name: string, defaultValue?: boolean): boolean;
  asTriple(
    name: string,
    defaultValue: OnOffAuto,
  ): OnOffAuto | { error: string };
  asInt(name: string, defaultValue?: number): number | { error: string };
};

export type OnOffAuto = 'on' | 'off' | 'auto';
