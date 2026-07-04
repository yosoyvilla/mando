"use client"

import { ChevronUpDownIcon } from "@/components/icons/lucide"
import type {
  ComboBoxProps as ComboBoxPrimitiveProps,
  InputProps,
  ListBoxProps,
  PopoverProps,
} from "react-aria-components"
import {
  Button,
  ComboBox as ComboBoxPrimitive,
  Group,
  Input,
  ListBox,
  useFilter,
} from "react-aria-components"
import { twJoin } from "tailwind-merge"
import { cx } from "@/lib/primitive"
import {
  DropdownDescription,
  DropdownItem,
  DropdownLabel,
  DropdownSection,
  DropdownSeparator,
} from "./dropdown"
import { fieldStyles } from "./field"
import { PopoverContent } from "./popover"

const ComboBox = <T extends object>({
  className,
  ...props
}: ComboBoxPrimitiveProps<T>) => {
  const { contains } = useFilter({ sensitivity: "base" })

  return (
    <ComboBoxPrimitive
      data-slot="control"
      defaultFilter={contains}
      className={cx(
        fieldStyles({ className: "group/combo-box min-w-0" }),
        className,
      )}
      {...props}
    />
  )
}

interface ComboBoxInputProps extends Omit<InputProps, "className" | "prefix"> {
  className?: string
  prefix?: React.ReactNode
}

const ComboBoxInput = ({
  className,
  prefix,
  ...props
}: ComboBoxInputProps) => {
  return (
    <Group
      data-slot="control"
      className={cx(
        "flex w-full min-w-0 items-center gap-x-2 rounded-lg border border-input px-[calc(--spacing(3.5)-1px)] py-[calc(--spacing(2.5)-1px)] text-fg outline-hidden transition duration-200 enabled:hover:border-muted-fg/30",
        "focus-within:border-ring/70 focus-within:ring-3 focus-within:ring-ring/20",
        "invalid:border-danger-subtle-fg/70 invalid:enabled:hover:border-danger-subtle-fg/80 focus-within:invalid:border-danger-subtle-fg/70 focus-within:invalid:ring-danger-subtle-fg/20",
        "disabled:bg-muted in-disabled:bg-muted forced-colors:in-disabled:text-[GrayText]",
        "sm:px-[calc(--spacing(3)-1px)] sm:py-[calc(--spacing(1.5)-1px)] dark:scheme-dark",
        "*:data-[slot=icon]:size-5 *:data-[slot=icon]:shrink-0 *:data-[slot=icon]:self-center *:data-[slot=icon]:text-muted-fg sm:*:data-[slot=icon]:size-4",
        className,
      )}
    >
      {prefix}
      <Input
        className="min-w-0 flex-1 appearance-none truncate bg-transparent text-base/6 text-fg outline-hidden placeholder:text-muted-fg sm:text-sm/6 [&::-ms-reveal]:hidden [&::-webkit-search-cancel-button]:hidden"
        {...props}
      />
      <Button
        aria-label="Show options"
        className={twJoin(
          "-mr-1 grid shrink-0 place-content-center self-center text-muted-fg outline-hidden hover:text-fg pressed:text-fg",
          "size-6 sm:size-5",
        )}
      >
        <ChevronUpDownIcon className="size-4" aria-hidden="true" />
      </Button>
    </Group>
  )
}

interface ComboBoxContentProps<T extends object>
  extends Omit<ListBoxProps<T>, "layout" | "orientation"> {
  items?: Iterable<T>
  popover?: Omit<PopoverProps, "children">
}

const ComboBoxContent = <T extends object>({
  items,
  className,
  popover,
  ...props
}: ComboBoxContentProps<T>) => {
  return (
    <PopoverContent
      placement={popover?.placement ?? "bottom"}
      className={cx("scroll-py-1 overflow-y-auto overscroll-contain", popover?.className)}
      {...popover}
    >
      <ListBox
        layout="stack"
        orientation="vertical"
        className={cx(
          "grid max-h-72 w-full grid-cols-[auto_1fr] flex-col gap-y-1 overflow-y-auto p-1 outline-hidden *:[[role='group']+[role=group]]:mt-4 *:[[role='group']+[role=separator]]:mt-1",
          className,
        )}
        items={items}
        {...props}
      />
    </PopoverContent>
  )
}

const ComboBoxItem = DropdownItem
const ComboBoxSection = DropdownSection
const ComboBoxSeparator = DropdownSeparator
const ComboBoxLabel = DropdownLabel
const ComboBoxDescription = DropdownDescription

export {
  ComboBox,
  ComboBoxContent,
  ComboBoxDescription,
  ComboBoxInput,
  ComboBoxItem,
  ComboBoxLabel,
  ComboBoxSection,
  ComboBoxSeparator,
}
export type { ComboBoxInputProps, ComboBoxContentProps }
