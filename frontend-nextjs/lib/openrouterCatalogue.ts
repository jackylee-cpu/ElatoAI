/**
 * OpenRouter's public model catalogue, trimmed to what the admin uses: the
 * Model tab's picker and the Usage page's LLM prices.
 *
 * Their /models endpoint is public, so no key is involved. Cached for an
 * hour: the catalogue changes a few times a week, not a few times a minute.
 * Returns null when OpenRouter cannot be reached, so callers can say so
 * rather than price everything at zero.
 */
export async function fetchOpenRouterModels(): Promise<IOpenRouterModel[] | null> {
    try {
        const response = await fetch("https://openrouter.ai/api/v1/models", {
            headers: { Accept: "application/json" },
            next: { revalidate: 3600 },
        });
        if (!response.ok) {
            console.error("OpenRouter model list failed:", response.status);
            return null;
        }

        const payload = await response.json();
        return (payload?.data ?? [])
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
            .sort((a: IOpenRouterModel, b: IOpenRouterModel) => a.id.localeCompare(b.id));
    } catch (error) {
        console.error("OpenRouter model list errored:", error);
        return null;
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
