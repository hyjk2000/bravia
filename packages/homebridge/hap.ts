import type { API } from "homebridge";

type RuntimeHAP = Omit<API["hap"], "Categories" | "HAPStatus"> & {
  // Preserve the member types without the ambient enum-object identity.
  [Enum in "Categories" | "HAPStatus"]: {
    [Member in keyof API["hap"][Enum]]: API["hap"][Enum][Member];
  };
};

/** The same Homebridge API at runtime; supports verbatimModuleSyntax without enum inlining. */
export type RuntimeAPI = Omit<API, "hap"> & { readonly hap: RuntimeHAP };
