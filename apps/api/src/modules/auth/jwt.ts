import { SignJWT, jwtVerify, errors as joseErrors } from "jose";
import type { UserRole } from "@mailapp/shared";
import { AppError } from "../../lib/errors.js";

export interface AccessClaims {
  sub: string;
  email: string;
  role: UserRole;
  name: string;
}

export class JwtService {
  private readonly key: Uint8Array;
  constructor(
    secret: string,
    private readonly ttlMinutes: number,
    private readonly issuer = "mailapp",
  ) {
    this.key = new TextEncoder().encode(secret);
  }

  async sign(claims: AccessClaims): Promise<string> {
    return new SignJWT({ email: claims.email, role: claims.role, name: claims.name })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(claims.sub)
      .setIssuer(this.issuer)
      .setIssuedAt()
      .setExpirationTime(`${this.ttlMinutes}m`)
      .sign(this.key);
  }

  async verify(token: string): Promise<AccessClaims> {
    try {
      const { payload } = await jwtVerify(token, this.key, { issuer: this.issuer, algorithms: ["HS256"] });
      return {
        sub: String(payload.sub),
        email: String(payload.email),
        role: payload.role as UserRole,
        name: String(payload.name ?? ""),
      };
    } catch (err) {
      if (err instanceof joseErrors.JWTExpired) throw AppError.unauthorized("Token expired", "token_expired");
      throw AppError.unauthorized("Invalid token", "invalid_token");
    }
  }
}
