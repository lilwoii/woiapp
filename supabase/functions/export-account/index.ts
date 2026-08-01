import {
  adminClient,
  authenticatedUser,
  corsHeaders,
  HttpError,
  jsonResponse,
  optionsResponse,
  publicError,
} from "../_shared/http.ts";

Deno.serve(async (request) => {
  let cors: HeadersInit = {};
  try {
    cors = corsHeaders(request);
    if (request.method === "OPTIONS") return optionsResponse(request);
    if (request.method !== "GET") throw new HttpError(405, "METHOD_NOT_ALLOWED");

    const { user } = await authenticatedUser(request, true);
    const admin = adminClient();
    const { data, error } = await admin.rpc("account_export_payload", {
      target_user_id: user.id,
    });
    if (error) throw error;

    const providers = Array.from(
      new Set((user.identities ?? []).map((identity) => identity.provider)),
    );
    const payload = {
      ...data,
      account: {
        email: user.email ?? null,
        phone: user.phone ?? null,
        providers,
        created_at: user.created_at,
        email_confirmed_at: user.email_confirmed_at ?? null,
        phone_confirmed_at: user.phone_confirmed_at ?? null,
        last_sign_in_at: user.last_sign_in_at ?? null,
      },
    };
    const date = new Date().toISOString().slice(0, 10);
    return jsonResponse(payload, 200, {
      ...cors,
      "Content-Disposition": `attachment; filename="spottr-account-export-${date}.json"`,
    });
  } catch (error) {
    return publicError(error, cors);
  }
});
