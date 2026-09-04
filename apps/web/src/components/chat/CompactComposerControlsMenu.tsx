import { ProviderInteractionMode, RuntimeMode } from "@t3tools/contracts";
import { RUNTIME_MODE_LABELS } from "@t3tools/client-runtime/providerRuntimeModes";
import { memo, type ReactNode, useState } from "react";
import { EllipsisIcon } from "lucide-react";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
  MenuTrigger,
} from "../ui/menu";
import { ComposerControl, ComposerControlIcon } from "./ComposerControl";
import { composerFloatingLayerProps } from "./composerEventScope";

export const CompactComposerControlsMenu = memo(function CompactComposerControlsMenu(props: {
  interactionMode: ProviderInteractionMode;
  runtimeMode: RuntimeMode;
  supportedRuntimeModes?: ReadonlyArray<RuntimeMode> | undefined;
  runtimeModeBlockReason?: string | null | undefined;
  showInteractionModeToggle: boolean;
  traitsMenuContent?: ReactNode;
  size?: "sm" | "xs";
  /**
   * The resting strip keeps this menu mounted out of flow while every block
   * fits inline. Its portaled popup would outlive that transition, so an
   * open menu closes when its trigger hides.
   */
  hidden?: boolean;
  onToggleInteractionMode: () => void;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
}) {
  const size = props.size ?? "sm";
  const [open, setOpen] = useState(false);
  const hidden = props.hidden ?? false;
  // Base UI does not report a close it did not initiate, so clear the state
  // when the trigger hides or the menu would reopen by itself when the
  // trigger returns.
  const [wasHidden, setWasHidden] = useState(hidden);
  if (hidden !== wasHidden) {
    setWasHidden(hidden);
    if (hidden) setOpen(false);
  }

  return (
    <Menu open={open && !hidden} onOpenChange={setOpen}>
      <MenuTrigger
        render={
          <ComposerControl
            size={size}
            variant="ghost"
            className={size === "xs" ? "shrink-0" : "shrink-0 px-2"}
            aria-label="More composer controls"
          />
        }
      >
        <ComposerControlIcon icon={EllipsisIcon} size={size} />
      </MenuTrigger>
      <MenuPopup align="start" {...composerFloatingLayerProps}>
        {props.traitsMenuContent ? (
          <>
            {props.traitsMenuContent}
            <MenuDivider />
          </>
        ) : null}
        {props.showInteractionModeToggle ? (
          <>
            <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Mode</div>
            <MenuRadioGroup
              value={props.interactionMode}
              onValueChange={(value) => {
                if (!value || value === props.interactionMode) return;
                props.onToggleInteractionMode();
              }}
            >
              <MenuRadioItem value="default">Chat</MenuRadioItem>
              <MenuRadioItem value="plan">Plan</MenuRadioItem>
            </MenuRadioGroup>
            <MenuDivider />
          </>
        ) : null}
        <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Access</div>
        {props.runtimeModeBlockReason ? (
          <p className="max-w-72 px-2 py-1.5 text-xs text-muted-foreground">
            {props.runtimeModeBlockReason}
          </p>
        ) : null}
        <MenuRadioGroup
          value={props.runtimeMode}
          onValueChange={(value) => {
            if (!value || value === props.runtimeMode) return;
            const mode = RuntimeMode.literals.find((mode) => mode === value);
            if (
              mode &&
              (props.supportedRuntimeModes === undefined ||
                props.supportedRuntimeModes.includes(mode))
            ) {
              props.onRuntimeModeChange(mode);
            }
          }}
        >
          {RuntimeMode.literals
            .filter(
              (mode) =>
                props.supportedRuntimeModes === undefined ||
                props.supportedRuntimeModes.includes(mode) ||
                mode === props.runtimeMode,
            )
            .map((mode) => (
              <MenuRadioItem
                key={mode}
                value={mode}
                disabled={
                  props.supportedRuntimeModes !== undefined &&
                  !props.supportedRuntimeModes.includes(mode)
                }
              >
                {RUNTIME_MODE_LABELS[mode]}
              </MenuRadioItem>
            ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
});
