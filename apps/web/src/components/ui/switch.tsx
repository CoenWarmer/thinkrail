import { cn } from "@/lib";

export function Switch({
	checked,
	disabled = false,
	label,
	testId,
	onChange,
}: {
	checked: boolean;
	disabled?: boolean;
	label: string;
	testId: string;
	onChange: (checked: boolean) => void;
}) {
	return (
		<button
			type="button"
			role="switch"
			disabled={disabled}
			aria-checked={checked}
			aria-label={label}
			data-testid={testId}
			data-active={checked}
			onClick={() => onChange(!checked)}
			className={cn(
				"relative h-20 w-36 shrink-0 rounded-full outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary disabled:pointer-events-none disabled:opacity-50",
				checked ? "bg-primary-subtle inset-ring-1 inset-ring-primary-muted" : "bg-border-default",
			)}
		>
			<span
				className={cn(
					"absolute top-2 left-2 size-16 rounded-full transition-transform",
					checked ? "translate-x-16 bg-primary" : "bg-container-workspace-bg",
				)}
			/>
		</button>
	);
}
