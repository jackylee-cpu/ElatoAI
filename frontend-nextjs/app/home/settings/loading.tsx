import { SkeletonCard, SkeletonHeader, SkeletonTabs } from "../HomeSkeleton";

export default function Loading() {
    return (
        <div className="relative z-10 mx-auto flex h-full w-full max-w-lg flex-col px-4 pt-[max(0.75rem,env(safe-area-inset-top))] md:max-w-xl md:px-8 md:pt-8">
            <SkeletonHeader width="w-32" />
            <SkeletonTabs count={2} />
            <SkeletonCard />
        </div>
    );
}
