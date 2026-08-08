export interface SessionIdentity {
  readonly value: string;
}

export type SessionResult =
  | { readonly ok: true; readonly value: SessionIdentity }
  | { readonly error: string; readonly ok: false };
