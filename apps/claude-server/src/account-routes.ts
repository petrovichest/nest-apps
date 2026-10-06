import type { FastifyInstance } from "fastify";
import type { ClaudeProxyInput, CreateClaudeLoginRequest } from "@codexnest/protocol";
import type { ClaudeAccounts } from "./accounts.js";
import { AppError, record } from "./types.js";
import { testClaudeProxy } from "./proxy.js";

export async function registerAccountRoutes(
  app: FastifyInstance,
  accounts: ClaudeAccounts,
): Promise<void> {
  const prefix = "/api/v1/settings/claude";
  app.get(prefix, () => accounts.status());
  app.patch(prefix, async (request) => {
    const body = record(request.body);
    if (typeof body.autoSwitch !== "boolean")
      throw new AppError("invalid_request", "autoSwitch must be a boolean");
    return accounts.setAutoSwitch(body.autoSwitch);
  });
  app.post(`${prefix}/refresh`, async (request) => {
    const body = request.body === undefined ? {} : record(request.body);
    if (body.accountId !== undefined && typeof body.accountId !== "string")
      throw new AppError("invalid_request", "accountId must be text");
    return accounts.refresh(body.accountId as string | undefined);
  });
  app.patch<{ Params: { id: string } }>(`${prefix}/accounts/:id`, (request) => {
    const body = record(request.body);
    return accounts.updateProxy(request.params.id, record(body.proxy) as ClaudeProxyInput);
  });
  app.delete<{ Params: { id: string } }>(`${prefix}/accounts/:id`, (request) =>
    accounts.remove(request.params.id),
  );
  app.post<{ Params: { id: string } }>(`${prefix}/accounts/:id/select`, (request) =>
    accounts.select(request.params.id),
  );
  app.post(`${prefix}/proxy/test`, (request) => {
    const body = record(request.body);
    return testClaudeProxy(record(body.proxy) as ClaudeProxyInput);
  });
  app.post(`${prefix}/logins`, (request) => {
    const body = record(request.body);
    if (body.accountId !== undefined && typeof body.accountId !== "string")
      throw new AppError("invalid_request", "accountId must be text");
    return accounts.startLogin({
      ...(body.proxy !== undefined ? { proxy: record(body.proxy) as ClaudeProxyInput } : {}),
      ...(body.accountId !== undefined ? { accountId: body.accountId } : {}),
    } as CreateClaudeLoginRequest);
  });
  app.get<{ Params: { id: string } }>(`${prefix}/logins/:id`, (request) =>
    accounts.login(request.params.id),
  );
  app.delete<{ Params: { id: string } }>(`${prefix}/logins/:id`, (request) =>
    accounts.cancelLogin(request.params.id),
  );
  app.post<{ Params: { id: string } }>(`${prefix}/logins/:id/code`, (request) => {
    const body = record(request.body);
    if (typeof body.code !== "string") throw new AppError("invalid_request", "code must be text");
    return accounts.submitCode(request.params.id, body.code);
  });
}
