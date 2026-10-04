import {
	RiGuideLine as Guide,
	RiArrowRightSLine as Next,
	RiArrowLeftSLine as Previous,
} from "@remixicon/react";
import { useEffect, useRef } from "react";
import type { WalkthroughCardStep } from "@/resources";

export function WalkthroughCard({
	step,
	onStep,
}: {
	step: WalkthroughCardStep;
	onStep: (index: number) => void;
}) {
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (step.active) ref.current?.scrollIntoView({ block: "center" });
	}, [step.active]);

	if (!step.active) {
		return (
			<button
				type="button"
				data-testid="walkthrough-marker"
				data-step={step.index}
				onClick={() => onStep(step.index)}
				className="pointer-events-auto my-4 ml-12 flex max-w-[832px] items-center gap-8 rounded-[var(--radius-md)] border border-border-muted bg-container-header-bg px-8 py-4 text-left tr-text-metadata text-text-muted transition-colors hover:bg-control-bg-hovered hover:text-text-default"
			>
				<Guide className="size-12 shrink-0" />
				<span className="min-w-0 flex-1 truncate">{step.title}</span>
				<span className="shrink-0 text-text-subtle">
					{step.index + 1}/{step.total}
				</span>
			</button>
		);
	}

	return (
		<div
			ref={ref}
			data-testid="walkthrough-card"
			data-step={step.index}
			className="pointer-events-auto my-4 ml-12 flex max-w-[832px] flex-col gap-8 rounded-[var(--radius-md)] border border-border-default bg-container-header-bg p-8"
		>
			<div className="flex items-center gap-8 px-4">
				<Guide className="size-14 shrink-0 text-primary" />
				<span className="min-w-0 flex-1 truncate tr-text-ui text-text-default">{step.title}</span>
				<span className="shrink-0 tr-text-eyebrow text-text-subtle">
					Step {step.index + 1} of {step.total}
				</span>
			</div>
			{step.body ? (
				<p className="m-0 min-w-0 break-words px-4 tr-text-ui text-text-muted">{step.body}</p>
			) : null}
			<div className="flex items-center justify-end gap-4 px-4">
				<button
					type="button"
					data-testid="walkthrough-previous"
					disabled={step.index === 0}
					onClick={() => onStep(step.index - 1)}
					className="flex items-center gap-2 rounded-[var(--radius-sm)] px-4 py-2 tr-text-metadata text-text-muted outline-none transition-colors hover:bg-control-bg-hovered hover:text-text-default focus-visible:ring-2 focus-visible:ring-primary disabled:pointer-events-none disabled:text-control-disabled-text"
				>
					<Previous className="size-14" />
					Previous
				</button>
				<button
					type="button"
					data-testid="walkthrough-next"
					disabled={step.index + 1 >= step.total}
					onClick={() => onStep(step.index + 1)}
					className="flex items-center gap-2 rounded-[var(--radius-sm)] px-4 py-2 tr-text-metadata text-text-muted outline-none transition-colors hover:bg-control-bg-hovered hover:text-text-default focus-visible:ring-2 focus-visible:ring-primary disabled:pointer-events-none disabled:text-control-disabled-text"
				>
					Next
					<Next className="size-14" />
				</button>
			</div>
		</div>
	);
}
