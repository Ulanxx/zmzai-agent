import { cookies } from "next/headers";

import { SessionModel, UserModel, hashToken, type UserRole, type UserStatus } from "@zmzai/db";

import { getServerEnvironment } from "@/config/env";
import { connectMongo } from "@/lib/database/mongodb";

export type CurrentUser = {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  status: UserStatus;
  emailVerified: boolean;
};

export async function getCurrentUser(): Promise<CurrentUser | null> {
  const environment = getServerEnvironment();
  const token = (await cookies()).get(environment.SESSION_COOKIE_NAME)?.value;
  if (!token) return null;

  await connectMongo();
  const session = await SessionModel.findOne({
    tokenHash: hashToken(environment.AUTH_SECRET, token),
    expiresAt: { $gt: new Date() },
  }).lean();
  if (!session) return null;

  const user = await UserModel.findById(session.userId).lean();
  if (!user || user.status !== "active" || (!user.emailVerified && user.role !== "admin")) return null;

  return {
    id: String(user._id),
    name: user.name,
    email: user.email,
    role: user.role,
    status: user.status,
    emailVerified: user.emailVerified,
  };
}
