export const BrowserOrientation = {
  Portrait: "PORTRAIT",
  Landscape: "LANDSCAPE",
} as const;

export type BrowserOrientationValue = (typeof BrowserOrientation)[keyof typeof BrowserOrientation];

export const SwipeDirection = {
  Up: "up",
  Down: "down",
  Left: "left",
  Right: "right",
} as const;

export type SwipeDirectionValue = (typeof SwipeDirection)[keyof typeof SwipeDirection];

export const PinchDirection = {
  In: "in",
  Out: "out",
} as const;

export type PinchDirectionValue = (typeof PinchDirection)[keyof typeof PinchDirection];
