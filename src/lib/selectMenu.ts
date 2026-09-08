/**
 * The parts of the custom dropdown that are decisions rather than markup:
 * which options a list holds, and where the list goes.
 *
 * Apart here so they can be reasoned about on their own — and tested, which a
 * `.tsx` file cannot be under the type-stripping test runner.
 */

import { Children, isValidElement, type ReactNode } from "react";

export type SelectOption = { value: string; label: string; disabled: boolean };

/**
 * The `<option>` children, as a list the menu can draw.
 *
 * `toArray` flattens the conditionals and maps these are written with; an
 * option that never reached the menu would be a value you could hold but not
 * choose. An option with no `value` is named by its own text, which is what
 * the DOM does.
 */
export function readOptions(children: ReactNode): SelectOption[] {
  return Children.toArray(children).flatMap((child) => {
    if (!isValidElement(child) || child.type !== "option") return [];
    const props = child.props as {
      value?: string | number;
      children?: ReactNode;
      disabled?: boolean;
    };
    const label =
      typeof props.children === "string"
        ? props.children
        : String(props.children ?? "");
    return [
      {
        value: props.value === undefined ? label : String(props.value),
        label,
        disabled: props.disabled === true,
      },
    ];
  });
}

/** Below the field, or above it where the window has no room underneath. */
export function menuPosition(
  field: { top: number; bottom: number; left: number; width: number },
  menuHeight: number,
  view: { width: number; height: number },
) {
  const margin = 8;
  const below = field.bottom + 4;
  const fits = below + menuHeight + margin <= view.height;
  const top = fits ? below : Math.max(margin, field.top - menuHeight - 4);
  // Never narrower than a name can be read in, and never off the side.
  const width = Math.max(field.width, 160);
  const left = Math.max(
    margin,
    Math.min(field.left, view.width - width - margin),
  );
  return { top, left, width };
}

/** Eight rows before it scrolls, which is the height a placement assumes. */
export function menuHeightFor(count: number) {
  return Math.min(count, 8) * 36 + 10;
}
