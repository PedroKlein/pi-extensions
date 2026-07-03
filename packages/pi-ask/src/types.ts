/** Shared types for the pi-ask extension */

/** Action to execute when an option with this action is selected and submitted */
export interface OptionAction {
	/** Action type. Currently only 'mode-switch' is supported. */
	type: "mode-switch";
	/** Target mode for mode-switch actions */
	mode: string;
}

export interface QuestionOption {
	value: string;
	label: string;
	/** Shown in the side detail panel when this option is highlighted */
	description?: string;
	/** Marks this option as agent-recommended (★ badge) */
	recommended?: boolean;
	/** Optional action to execute when this option is selected and submitted */
	action?: OptionAction;
}

export interface Question {
	id: string;
	/** Short label for the tab bar (defaults to "Q1", "Q2"...) */
	label?: string;
	/** Full question text displayed above options */
	prompt: string;
	/** single = radio, multi = checkbox, text = free-form input */
	type: "single" | "multi" | "text";
	/** Help text shown below the prompt */
	context?: string;
	/** Available options (required for single/multi, ignored for text) */
	options?: QuestionOption[];
}

export interface Selection {
	value: string;
	label: string;
	/** Was this typed by the user via "Other"? */
	custom: boolean;
	/** One-liner annotation the user added */
	annotation?: string;
}

export interface QuestionAnswer {
	id: string;
	/** For single/multi */
	selections: Selection[];
	/** For text type */
	freeText?: string;
}

export interface AskUserResult {
	questions: Question[];
	answers: QuestionAnswer[];
	cancelled: boolean;
	/** Optional free-form note added by the user before submitting */
	globalNote?: string;
}

/** Normalized question with defaults applied */
export interface NormalizedQuestion extends Question {
	label: string;
	options: QuestionOption[];
}
