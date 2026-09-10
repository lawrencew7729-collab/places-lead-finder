/** Shared session types (server boundary). */
export interface VerifiedSession {
  operatorUserId: string;
  roles: string[];
  email?: string;
  exp?: number;
}
