import fp from "fastify-plugin";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { UserRole } from "@mailapp/shared";
import { AppError } from "../../lib/errors.js";
import type { AccessClaims } from "./jwt.js";
import type { AppContext } from "../../context.js";

export const ACCESS_COOKIE = "mailapp_access";
export const REFRESH_COOKIE = "mailapp_refresh";
export const CSRF_HEADER = "x-requested-with";
export const CSRF_VALUE = "mailapp";

declare module "fastify" {
  interface FastifyRequest {
    user: AccessClaims | null;
  }
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireRole: (...roles: UserRole[]) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

const ROLE_RANK: Record<UserRole, number> = { viewer: 1, operator: 2, admin: 3 };

export function roleAtLeast(role: UserRole, min: UserRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

export const authPlugin = fp(async (app: FastifyInstance, opts: { ctx: AppContext }) => {
  const { ctx } = opts;
  app.decorateRequest("user", null);

  app.decorate("authenticate", async (req: FastifyRequest) => {
    let token = req.cookies[ACCESS_COOKIE];
    const header = req.headers.authorization;
    if (!token && header?.startsWith("Bearer ")) token = header.slice(7);
    if (!token) throw AppError.unauthorized();
    req.user = await ctx.auth.jwt.verify(token);
    // CSRF: cookie-authenticated mutating requests must carry the custom header.
    if (req.cookies[ACCESS_COOKIE] && !["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      if ((req.headers[CSRF_HEADER] as string | undefined) !== CSRF_VALUE) {
        throw AppError.forbidden("Missing CSRF header");
      }
    }
  });

  app.decorate("requireRole", (...roles: UserRole[]) => {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      await app.authenticate(req, reply);
      const role = req.user?.role;
      if (!role || !roles.some((r) => roleAtLeast(role, r))) throw AppError.forbidden();
    };
  });
});

export function cookieOptions(ctx: AppContext, path: string, maxAgeSeconds: number) {
  return {
    httpOnly: true,
    secure: ctx.config.isProd,
    sameSite: "lax" as const,
    path,
    maxAge: maxAgeSeconds,
  };
}
