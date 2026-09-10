import { NextResponse } from "next/server";
import { assertAdmin } from "@/lib/admin";

/**
 * The OpenRouter catalogue, trimmed to what the model picker shows.
 *
 * Proxied rather than fetched from the browser for two reasons: it keeps the
 * admin allowlist in front of it, and OpenRouter's list is a few hundred KB of
 * JSON that would otherwise cross the wire on every render. Their /models
 * endpoint is public, so no key is involved.
 */
export async function GET() {
    await assertAdmin();

    try {
        const response = await fetch("https://openrouter.ai/api/v1/models", {
            headers: { Accept: "application/json" },
            // The catalogue changes a few times a week, not a few times a minute.
            next: { revalidate: 3600 },
        });

        if (!response.ok) {
            console.error("OpenRouter model list failed:", response.status);
            return NextResponse.json(
                { error: "Could not reach OpenRouter", models: [] },
                { status: 502 },
            );
        }

        const payload = await response.json();
        const models: IOpenRouterModel[] = (payload?.data ?? [])
            .map((model: Record<string, any>) => ({
                id: String(model.id ?? ""),
                name: String(model.name ?? model.id ?? ""),
                context_length: numberOrNull(model.context_length),
                // Priced per token, as strings. Per million is the unit
                // everyone actually compares in.
                prompt_price: perMillion(model?.pricing?.prompt),
                completion_price: perMillion(model?.pricing?.completion),
            }))
            .filter((model: IOpenRouterModel) => model.id)
            .sort((a: IOpenRouterModel, b: IOpenRouterModel) =>
                a.id.localeCompare(b.id),
            );

        return NextResponse.json({ models });
    } catch (error) {
        console.error("OpenRouter model list errored:", error);
        return NextResponse.json(
            { error: "Could not reach OpenRouter", models: [] },
            { status: 502 },
        );
    }
}

function numberOrNull(value: unknown): number | null {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function perMillion(value: unknown): number | null {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return null;
    return parsed * 1_000_000;
}
