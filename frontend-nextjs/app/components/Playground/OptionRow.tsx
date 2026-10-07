import { cn } from "@/lib/utils";

// A labelled row of pill buttons, one of which is selected.
interface Option {
    key: string | null;
    label: string;
    description?: string;
}

interface OptionRowProps {
    label: string;
    options: Option[];
    value: string | null;
    onChange: (value: string | null) => void;
    disabled?: boolean;
}

export const OptionRow = ({ label, options, value, onChange, disabled }: OptionRowProps) => (
    <div className="flex flex-col gap-1.5">
        <p className="px-1 text-xs font-medium uppercase tracking-wider text-gray-500">
            {label}
        </p>
        <div className="flex flex-wrap gap-2">
            {options.map((option) => {
                const isActive = option.key === value;
                return (
                    <button
                        key={option.key ?? "default"}
                        type="button"
                        disabled={disabled}
                        title={option.description}
                        onClick={() => onChange(option.key)}
                        className={cn(
                            "shrink-0 rounded-full px-3.5 py-1.5 text-sm transition-all disabled:opacity-50",
                            isActive
                                ? "bg-white font-semibold text-gray-900 shadow-sm"
                                : "bg-white/60 font-medium text-gray-500 hover:text-gray-700"
                        )}
                    >
                        {option.label}
                    </button>
                );
            })}
        </div>
    </div>
);
