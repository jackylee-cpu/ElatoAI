import { NextResponse } from "next/server";
import { adminSessionOrNull } from "@/lib/admin";
import { fetchOpenRouterModels } from "@/lib/openrouterCatalogue";

/**
 * The OpenRouter catalogue, trimmed to what the model picker shows.
 *
 * Proxied rather than fetched from the browser for two reasons: it keeps the
 * admin role check in front of it, and OpenRouter's list is a few hundred KB of
 * JSON that would otherwise cross the wire on every render.
 */
export async function GET() {
    // The model picker is the super admin's Model tab. middleware.ts has
    // already turned away anyone without a role.
    if (!(await adminSessionOrNull("super_admin"))) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const models = await fetchOpenRouterModels();
    if (models === null) {
        return NextResponse.json(
            { error: "Could not reach OpenRouter", models: [] },
            { status: 502 },
        );
    }
    return NextResponse.json({ models });
}
