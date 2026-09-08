import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type SelectHTMLAttributes,
} from "react";
import { createPortal } from "react-dom";
import { Check } from "lucide-react";
import {
  menuHeightFor,
  menuPosition,
  readOptions,
  type SelectOption,
} from "../lib/selectMenu";

/**
 * A dropdown the app draws itself, where drawing it is an improvement.
 *
 * The list a native `<select>` opens belongs to the operating system: white
 * rows in a system font, with a blue highlight, in the middle of a dark
 * application. On a phone that is the right answer — iOS and Android open a
 * proper picker sized for a thumb, which nothing here would beat — so this
 * only replaces the list where there is a mouse.
 *
 * The `<select>` itself always stays in the tree. It is what every stylesheet
 * rule in the app already targets, what a screen reader announces, and what
 * holds the value; only the popup it would open is suppressed and replaced.
 * That is also why this is a drop-in for the element it wraps: same props,
 * same `<option>` children, same change event.
 */

type SelectProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, "onChange"> & {
  /** Narrower than React's, so an inline handler reading `target.value` fits. */
  onChange?(event: { target: { value: string } }): void;
  children?: ReactNode;
};

/** A mouse, rather than a thumb. The same test the stylesheet uses for hover. */
function usesPointer() {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(hover: hover) and (pointer: fine)").matches
  );
}

export function Select({ onChange, children, ...rest }: SelectProps) {
  const field = useRef<HTMLSelectElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [custom, setCustom] = useState(false);
  const [open, setOpen] = useState(false);
  const [box, setBox] = useState({ top: 0, left: 0, width: 0 });
  const options = useMemo(() => readOptions(children), [children]);
  const value = rest.value === undefined ? undefined : String(rest.value);
  const [active, setActive] = useState(0);

  // Settled after mounting rather than during render, so the markup a server
  // or a test renders is the plain element either way.
  useEffect(() => setCustom(usesPointer()), []);

  const place = () => {
    const element = field.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    setBox(
      menuPosition(rect, menuHeightFor(options.length), {
        width: window.innerWidth,
        height: window.innerHeight,
      }),
    );
  };
  useLayoutEffect(() => {
    if (open) place();
    // Position depends on where the field is, which only matters when opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const inside = (node: EventTarget | null) =>
      node instanceof Node &&
      (menu.current?.contains(node) || field.current?.contains(node));

    const onScroll = (event: Event) => {
      // Scrolling the list is not scrolling away from it. Without this the
      // capture listener below caught the menu's own scroll and closed it, so
      // a list long enough to need scrolling could not be scrolled at all.
      if (menu.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    // Capture, so a scroller anywhere between the field and the window still
    // closes this: the menu is positioned in the viewport and would otherwise
    // stay put while the field it belongs to slid away.
    const onResize = () => setOpen(false);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);

    // Dismissed by a press outside rather than by a full-screen scrim. The
    // scrim swallowed that press, so opening a second dropdown took two
    // clicks: one to dismiss the first, and another that finally reached the
    // field. Nothing is covered now, so the press that closes this one also
    // opens the next.
    const onPress = (event: PointerEvent) => {
      if (inside(event.target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPress, true);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("pointerdown", onPress, true);
    };
  }, [open]);

  const choose = (next: string) => {
    setOpen(false);
    field.current?.focus();
    if (next !== value) onChange?.({ target: { value: next } });
  };

  const openAt = () => {
    // Suppressing the mousedown default also suppressed the focus it would
    // have moved, which left Escape and the arrow keys going to the document
    // instead of to the field that opened this.
    field.current?.focus();
    const current = options.findIndex((option) => option.value === value);
    setActive(current < 0 ? 0 : current);
    setOpen(true);
  };

  const step = (by: number) => {
    if (!options.length) return;
    let next = active;
    for (let tries = 0; tries < options.length; tries += 1) {
      next = (next + by + options.length) % options.length;
      if (!options[next].disabled) break;
    }
    setActive(next);
  };

  return (
    <>
      <select
        {...rest}
        ref={field}
        onChange={onChange}
        onMouseDown={
          custom
            ? (event) => {
                // The only way to stop the platform drawing its own list.
                event.preventDefault();
                if (rest.disabled) return;
                if (open) setOpen(false);
                else openAt();
              }
            : undefined
        }
        onKeyDown={
          custom
            ? (event) => {
                if (rest.disabled) return;
                if (!open) {
                  // The keys that would have opened the platform's list open
                  // ours. Everything else — typing to jump, arrows to step
                  // through values — is left to the element, which does it
                  // well and fires its own change.
                  if (
                    event.key === "Enter" ||
                    event.key === " " ||
                    event.key === "F4" ||
                    (event.altKey && event.key === "ArrowDown")
                  ) {
                    event.preventDefault();
                    openAt();
                  }
                  return;
                }
                if (event.key === "Escape" || event.key === "Tab") {
                  setOpen(false);
                  return;
                }
                // While it is open these belong to the list, not to the field,
                // or a press would move the highlight and the value at once.
                event.preventDefault();
                if (event.key === "ArrowDown") step(1);
                else if (event.key === "ArrowUp") step(-1);
                else if (event.key === "Home") setActive(0);
                else if (event.key === "End") setActive(options.length - 1);
                else if (event.key === "Enter" || event.key === " ") {
                  const option = options[active];
                  if (option && !option.disabled) choose(option.value);
                }
              }
            : undefined
        }
      >
        {children}
      </select>
      {custom &&
        open &&
        createPortal(
          <div
            ref={menu}
            className="select-menu"
            role="listbox"
            style={{ top: box.top, left: box.left, width: box.width }}
          >
              {options.map((option, index) => (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={option.value === value}
                  className={`${option.value === value ? "selected" : ""}${
                    index === active ? " is-active" : ""
                  }`}
                  disabled={option.disabled}
                  onMouseEnter={() => setActive(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(option.value)}
                >
                  <span>{option.label}</span>
                  {option.value === value && <Check />}
                </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
