import { NextResponse } from "next/server";
import { assertAdmin } from "@/lib/admin";

/**
 * Providers currently hosting one OpenRouter model.
 *
 * The model picker only has ids; which hosts are up is a different, smaller
 * list that changes as providers drop in and out. Fetched on the selected
 * model so the preferred-provider control only offers names OpenRouter will
 * actually accept in `provider.order`.
 */
export async function GET(request: Request) {
    await assertAdmin();

    const model = new URL(request.url).searchParams.get("model")?.trim() ?? "";
    if (!MODEL_ID.test(model)) {
        return NextResponse.json(
            { error: "Unknown model", endpoints: [] },
            { status: 400 },
        );
    }

    try {
        const response = await fetch(
            `https://openrouter.ai/api/v1/models/${model}/endpoints`,
            {
                headers: { Accept: "application/json" },
                next: { revalidate: 300 },
            },
        );

        if (!response.ok) {
            console.error(
                "OpenRouter endpoints failed:",
                model,
                response.status,
            );
            return NextResponse.json(
                { error: "Could not reach OpenRouter", endpoints: [] },
                { status: 502 },
            );
        }

        const payload = await response.json();
        const seen = new Set<string>();
        const endpoints: IOpenRouterEndpoint[] = [];

        for (const endpoint of payload?.data?.endpoints ?? []) {
            const slug = endpointSlug(endpoint);
            if (!slug || seen.has(slug)) continue;
            seen.add(slug);
            endpoints.push({
                slug,
                name: String(endpoint.provider_name ?? slug),
                quantization:
                    typeof endpoint.quantization === "string" &&
                    endpoint.quantization !== "unknown"
                        ? endpoint.quantization
                        : null,
                uptime: numberOrNull(
                    endpoint.uptime_last_1d ?? endpoint.uptime_last_30m,
                ),
            });
        }

        return NextResponse.json({ endpoints });
    } catch (error) {
        console.error("OpenRouter endpoints errored:", error);
        return NextResponse.json(
            { error: "Could not reach OpenRouter", endpoints: [] },
            { status: 502 },
        );
    }
}

// OpenRouter model ids are `author/slug`, sometimes with a `:variant`.
const MODEL_ID = /^[a-z0-9._-]+\/[a-z0-9._-]+(?::[a-z0-9._-]+)?$/i;

function endpointSlug(endpoint: Record<string, unknown>): string {
    const tag = String(endpoint.tag ?? "");
    const fromTag = tag.split("/")[0]?.trim().toLowerCase() ?? "";
    if (fromTag) return fromTag;
    return String(endpoint.provider_name ?? "")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, "-");
}

function numberOrNull(value: unknown): number | null {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}
