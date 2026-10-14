import { Shimmer, SkeletonCard } from "@/app/home/HomeSkeleton";

// Stands in for AdminDashboard's sidebar and page while the server fetches.
export default function Loading() {
    return (
        <div className="relative z-10 mx-auto flex h-full w-full max-w-7xl flex-col gap-3 px-4 pt-[max(0.75rem,env(safe-area-inset-top))] md:flex-row md:gap-6 md:px-6 md:pt-6">
            <aside className="flex shrink-0 flex-col gap-3 md:w-56">
                <Shimmer className="h-14 rounded-[24px] bg-white/90" />
                <div className="flex gap-1 rounded-full bg-white/90 p-1 md:flex-col md:gap-2 md:rounded-[24px] md:p-2.5">
                    {Array.from({ length: 6 }).map((_, i) => (
                        <Shimmer key={i} className="h-8 w-24 bg-gray-100 md:w-full" />
                    ))}
                </div>
            </aside>
            <main className="min-w-0 flex-1">
                <Shimmer className="mb-2 h-8 w-40 rounded-xl" />
                <Shimmer className="mb-4 h-4 w-72 max-w-full rounded-xl" />
                <SkeletonCard />
            </main>
        </div>
    );
}
