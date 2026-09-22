import { cn } from "@/lib/utils";

// Shared pieces for the /home loading.tsx files. The background and the page
// shell come from HomeShell, so these stand in only for the content column --
// that is the part the server is still fetching.

export function Shimmer({ className }: { className?: string }) {
    return (
        <div className={cn("animate-pulse rounded-full bg-white/60", className)} />
    );
}

export function SkeletonHeader({ width = "w-40" }: { width?: string }) {
    return (
        <header className="relative mb-3 flex h-14 shrink-0 items-center justify-center md:h-16">
            <Shimmer className="absolute left-0 top-1/2 h-10 w-10 -translate-y-1/2" />
            <Shimmer className={cn("h-7 rounded-xl", width)} />
        </header>
    );
}

export function SkeletonTabs({ count }: { count: number }) {
    return (
        <div
            className="mx-auto mb-5 grid w-full max-w-lg gap-1 rounded-full bg-white/90 p-1 shadow-[0_4px_16px_rgba(80,120,180,0.08)]"
            style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` }}
        >
            {Array.from({ length: count }).map((_, i) => (
                <Shimmer key={i} className="h-9 bg-gray-100" />
            ))}
        </div>
    );
}

export function SkeletonCard({ className }: { className?: string }) {
    return (
        <div
            className={cn(
                "rounded-[24px] bg-white/90 p-4 shadow-[0_8px_24px_rgba(80,120,180,0.08)] backdrop-blur-sm md:p-6",
                className
            )}
        >
            <div className="flex flex-col gap-4">
                <Shimmer className="h-4 w-2/3 rounded-xl bg-gray-100" />
                <Shimmer className="h-11 w-full rounded-2xl bg-gray-100" />
                <Shimmer className="h-4 w-1/2 rounded-xl bg-gray-100" />
                <Shimmer className="h-11 w-full rounded-2xl bg-gray-100" />
                <Shimmer className="h-4 w-1/3 rounded-xl bg-gray-100" />
                <Shimmer className="h-11 w-full rounded-2xl bg-gray-100" />
            </div>
        </div>
    );
}
