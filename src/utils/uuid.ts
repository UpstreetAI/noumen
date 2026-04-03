import { v4 } from "uuid";

export type UUID = string & { readonly __brand: unique symbol };

export function generateUUID(): UUID {
  return v4() as UUID;
}
