import { Shimmer } from "./HomeSkeleton";

// Without a loading boundary, <Link> prefetch on a force-dynamic route fetches
// nothing, so a tap sits on the old screen until the whole RSC round trip
// (auth + personality queries) comes back. This gives the router something to
// prefetch and paints the playground frame immediately.
export default function Loading() {
    return (
        <div className="relative z-10 mx-auto flex h-full w-full max-w-5xl flex-col px-4 pt-[max(1.25rem,env(safe-area-inset-top))] md:px-8 md:pt-8">
            <header className="relative flex h-14 shrink-0 items-center justify-center md:h-16">
                <Shimmer className="h-7 w-36 rounded-xl" />
                <Shimmer className="absolute right-0 top-1/2 h-10 w-10 -translate-y-1/2 md:h-11 md:w-11" />
            </header>

            <div className="shrink-0 pb-4 pt-1">
                <div className="flex justify-center gap-2">
                    {Array.from({ length: 3 }).map((_, i) => (
                        <Shimmer key={i} className="h-9 w-24" />
                    ))}
                </div>
            </div>

            <div className="scrollbar-hide flex-1 overflow-y-auto pb-32 md:pb-36">
                <div className="flex w-full flex-col gap-3">
                    <Shimmer className="ml-1 h-3 w-24 rounded-xl" />
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4 lg:gap-5">
                        {Array.from({ length: 8 }).map((_, i) => (
                            <div key={i} className="flex flex-col items-center py-2">
                                <Shimmer className="h-[110px] w-[110px] sm:h-[124px] sm:w-[124px] md:h-[140px] md:w-[140px]" />
                                <Shimmer className="mt-3 h-3 w-16 rounded-xl" />
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        </div>
    );
}
