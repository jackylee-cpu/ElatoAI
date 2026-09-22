import { SkeletonCard, SkeletonHeader, SkeletonTabs } from "../HomeSkeleton";

export default function Loading() {
    return (
        <div className="relative z-10 mx-auto flex h-full w-full max-w-5xl flex-col px-4 pt-[max(0.75rem,env(safe-area-inset-top))] md:px-8 md:pt-8">
            <SkeletonHeader width="w-24" />
            <SkeletonTabs count={3} />
            <SkeletonCard />
        </div>
    );
}
