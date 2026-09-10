"use client";

import React, { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
    Command,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { toast } from "@/components/ui/use-toast";
import { Check, ChevronsUpDown, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { saveVoiceStackAction } from "@/app/home/admin/actions";

const PROVIDER_SORTS: { value: OpenRouterProviderSort; label: string }[] = [
    { value: "latency", label: "latency — fastest first token" },
    { value: "throughput", label: "throughput — most tokens/sec" },
    { value: "nitro", label: "nitro — fastest, at a premium" },
    { value: "price", label: "price — cheapest provider" },
];

const SERVER_DEFAULT = "__server_default__";

interface ModelSettingsTabProps {
    settings: IVoiceStackSettings;
}

const ModelSettingsTab: React.FC<ModelSettingsTabProps> = ({ settings }) => {
    const [model, setModel] = useState(settings.llm_model ?? "");
    const [sort, setSort] = useState<string>(settings.provider_sort ?? SERVER_DEFAULT);
    const [models, setModels] = useState<IOpenRouterModel[]>([]);
    const [loadingModels, setLoadingModels] = useState(true);
    const [catalogueError, setCatalogueError] = useState(false);
    const [open, setOpen] = useState(false);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        let cancelled = false;
        fetch("/api/admin/openrouter-models")
            .then((response) => response.json())
            .then((payload) => {
                if (cancelled) return;
                setModels(payload.models ?? []);
                setCatalogueError(Boolean(payload.error));
            })
            .catch(() => !cancelled && setCatalogueError(true))
            .finally(() => !cancelled && setLoadingModels(false));
        return () => {
            cancelled = true;
        };
    }, []);

    const dirty =
        model !== (settings.llm_model ?? "") ||
        sort !== (settings.provider_sort ?? SERVER_DEFAULT);

    const onSave = async () => {
        setSaving(true);
        const result = await saveVoiceStackAction({
            llm_model: model,
            provider_sort:
                sort === SERVER_DEFAULT
                    ? undefined
                    : (sort as OpenRouterProviderSort),
        });
        setSaving(false);

        if (result.ok) {
            toast({
                title: "Saved",
                description: "New sessions will use it. Reconnect to hear the change.",
            });
        } else {
            toast({ title: "Could not save", description: result.error });
        }
    };

    const selected = models.find((entry) => entry.id === model);

    return (
        <div className="flex flex-col gap-4">
            <Card>
                <CardHeader>
                    <CardTitle className="text-lg">OpenRouter model</CardTitle>
                    <CardDescription>
                        Used by every session on the OpenRouter route. Leave it
                        empty to fall back to whatever the voice server was
                        started with.
                    </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-4">
                    <div className="flex flex-col gap-2">
                        <label className="text-sm font-medium">Model</label>
                        <Popover open={open} onOpenChange={setOpen}>
                            <PopoverTrigger asChild>
                                <Button
                                    variant="outline"
                                    role="combobox"
                                    aria-expanded={open}
                                    className="justify-between font-normal"
                                >
                                    <span className="truncate">
                                        {model || "Server default"}
                                    </span>
                                    {loadingModels ? (
                                        <Loader2 className="ml-2 h-4 w-4 shrink-0 animate-spin" />
                                    ) : (
                                        <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                                    )}
                                </Button>
                            </PopoverTrigger>
                            <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
                                <Command>
                                    <CommandInput placeholder="Search models…" />
                                    <CommandList>
                                        <CommandEmpty>No model found.</CommandEmpty>
                                        <CommandGroup>
                                            <CommandItem
                                                value="server default"
                                                onSelect={() => {
                                                    setModel("");
                                                    setOpen(false);
                                                }}
                                            >
                                                <Check
                                                    className={cn(
                                                        "mr-2 h-4 w-4",
                                                        model === "" ? "opacity-100" : "opacity-0",
                                                    )}
                                                />
                                                Server default
                                            </CommandItem>
                                            {models.map((entry) => (
                                                <CommandItem
                                                    key={entry.id}
                                                    value={entry.id}
                                                    onSelect={(value) => {
                                                        setModel(value);
                                                        setOpen(false);
                                                    }}
                                                >
                                                    <Check
                                                        className={cn(
                                                            "mr-2 h-4 w-4",
                                                            model === entry.id
                                                                ? "opacity-100"
                                                                : "opacity-0",
                                                        )}
                                                    />
                                                    <div className="flex flex-col min-w-0">
                                                        <span className="truncate">{entry.id}</span>
                                                        <span className="text-xs text-muted-foreground">
                                                            {describeModel(entry)}
                                                        </span>
                                                    </div>
                                                </CommandItem>
                                            ))}
                                        </CommandGroup>
                                    </CommandList>
                                </Command>
                            </PopoverContent>
                        </Popover>
                        {catalogueError && (
                            <p className="text-xs text-amber-600 dark:text-amber-500">
                                Could not load the OpenRouter catalogue. The saved
                                model is unaffected.
                            </p>
                        )}
                        {selected && (
                            <p className="text-xs text-muted-foreground">
                                {describeModel(selected)}
                            </p>
                        )}
                    </div>

                    <div className="flex flex-col gap-2">
                        <label className="text-sm font-medium">Provider routing</label>
                        <Select value={sort} onValueChange={setSort}>
                            <SelectTrigger>
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value={SERVER_DEFAULT}>Server default</SelectItem>
                                {PROVIDER_SORTS.map((entry) => (
                                    <SelectItem key={entry.value} value={entry.value}>
                                        {entry.label}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        <p className="text-xs text-muted-foreground">
                            OpenRouter serves most models from several providers.
                            This picks which one, and for speech `latency` is
                            usually the one you want.
                        </p>
                    </div>

                    <div className="flex flex-row items-center gap-3">
                        <Button onClick={onSave} disabled={saving || !dirty}>
                            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                            Save
                        </Button>
                        {dirty && !saving && (
                            <span className="text-xs text-muted-foreground">
                                Unsaved changes
                            </span>
                        )}
                    </div>
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle className="text-base">When this takes effect</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-2 text-sm text-muted-foreground">
                    <p>
                        The model is fixed when a session&apos;s pipeline is
                        built, so a conversation already in progress keeps the
                        model it started on. The next connection picks up the new
                        one.
                    </p>
                    <p>
                        For a toy that is awake right now, changing its character
                        on the Playground drops and re-establishes the session,
                        which is the quickest way to force it.
                    </p>
                    <div className="flex flex-row gap-2 pt-1">
                        <Badge variant="outline">
                            Saved: {settings.llm_model ?? "server default"}
                        </Badge>
                        <Badge variant="outline">
                            Routing: {settings.provider_sort ?? "server default"}
                        </Badge>
                    </div>
                </CardContent>
            </Card>
        </div>
    );
};

function describeModel(model: IOpenRouterModel): string {
    const parts: string[] = [];
    if (model.context_length) {
        parts.push(`${Math.round(model.context_length / 1000)}k ctx`);
    }
    if (model.prompt_price !== null) {
        parts.push(`$${model.prompt_price.toFixed(2)}/M in`);
    }
    if (model.completion_price !== null) {
        parts.push(`$${model.completion_price.toFixed(2)}/M out`);
    }
    return parts.join(" · ") || model.name;
}

export default ModelSettingsTab;
