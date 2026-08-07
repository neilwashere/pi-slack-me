import {
  confirmWrite,
  type ConfirmContext,
  type ConfirmOutcome,
  type ConfirmWriteOptions,
} from "./confirm";

export interface SlackWriteReviewer {
  readonly hasUI: boolean;
  review(options: ConfirmWriteOptions): Promise<ConfirmOutcome>;
}

export function createSlackWriteReviewer(
  ctx: ConfirmContext,
): SlackWriteReviewer {
  return {
    hasUI: ctx.hasUI,
    review: (options) => confirmWrite(ctx, options),
  };
}
