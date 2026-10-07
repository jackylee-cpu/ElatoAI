import { cn } from "@/lib/utils";

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

interface SessionOptionsProps {
    modes: IMode[];
    styles: IStyle[];
    modeKey: string | null;
    styleKey: string | null;
    onModeChange: (modeKey: string | null) => void;
    onStyleChange: (styleKey: string | null) => void;
    disabled?: boolean;
}

/**
 * What the character does and how it does it, for the account.
 *
 * "Default" is null in the database: the character's own prompt, with no mode
 * or style added -- what every session was before modes existed. With a mode
 * chosen the child can still ask the toy to switch to another one; this is
 * only where it starts.
 */
const SessionOptions = ({
    modes,
    styles,
    modeKey,
    styleKey,
    onModeChange,
    onStyleChange,
    disabled,
}: SessionOptionsProps) => {
    if (modes.length === 0 && styles.length === 0) {
        return null;
    }
    return (
        <div className="mx-auto flex w-full max-w-[400px] flex-col gap-3">
            {modes.length > 0 && (
                <OptionRow
                    label="Activity"
                    value={modeKey}
                    onChange={onModeChange}
                    disabled={disabled}
                    options={[
                        { key: null, label: "Default", description: "Just the character" },
                        ...modes.map((mode) => ({
                            key: mode.mode_key,
                            label: mode.name,
                            description: mode.description,
                        })),
                    ]}
                />
            )}
            {styles.length > 0 && (
                <OptionRow
                    label="Personality"
                    value={styleKey}
                    onChange={onStyleChange}
                    disabled={disabled}
                    options={[
                        { key: null, label: "Default", description: "The character as written" },
                        ...styles.map((style) => ({
                            key: style.style_key,
                            label: style.name,
                            description: style.description,
                        })),
                    ]}
                />
            )}
        </div>
    );
};

export default SessionOptions;
