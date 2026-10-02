// The shared component library. Import from "@/components".
export { cx, type Tone } from "./cx";

// layout
export { Panel, type PanelProps } from "./layout/Panel";
export { PageHeader, type PageHeaderProps } from "./layout/PageHeader";
export { Grid, Col, type ColProps } from "./layout/Grid";
export { Drawer, Sheet, type DrawerProps } from "./layout/Drawer";
export { SidePanel, SplitView, useIsPhone, type SidePanelProps } from "./layout/SidePanel";
export { Modal, type ModalProps } from "./layout/Modal";
export { Tabs, type TabsProps, type TabItem } from "./layout/Tabs";

// data display
export { MetricTile, type MetricTileProps, type Delta } from "./data/MetricTile";
export { StatusPill, type StatusPillProps, type PillStatus } from "./data/StatusPill";
export { DataTable, type DataTableProps, type Column, type RowAction, type SortState } from "./data/DataTable";
export { StepList, type StepListProps, type Step, type StepState } from "./data/StepList";
export { LogView, type LogViewProps, type LogLine, type LogLevel } from "./data/LogView";
export { KeyValue, type KeyValueProps, type KeyValueItem } from "./data/KeyValue";
export { CopyButton, type CopyButtonProps } from "./data/CopyButton";
export { Diff, diffLines, type DiffProps, type DiffLine } from "./data/Diff";
export { DataAge, formatAge, type DataAgeProps } from "./data/DataAge";

// charts
export { Sparkline, type SparklineProps } from "./charts/Sparkline";
export { TimeSeriesChart, type TimeSeriesChartProps, type TimeSeries, type ChartRange } from "./charts/TimeSeriesChart";
export { BarChart, type BarChartProps, type Bar } from "./charts/BarChart";
export { StackedBars, type StackedBarsProps, type StackSeries, type StackBucket, type BrushRange } from "./charts/StackedBars";
export { Donut, type DonutProps, type DonutSegment } from "./charts/Donut";
export { Ring, type RingProps } from "./charts/Ring";
export { ProgressBar, type ProgressBarProps } from "./charts/ProgressBar";

// forms
export { Button, type ButtonProps } from "./forms/Button";
export { IconButton, type IconButtonProps } from "./forms/IconButton";
export { Select, type SelectProps, type SelectOption } from "./forms/Select";
export { Switch, type SwitchProps } from "./forms/Switch";
export { Chips, type ChipsProps, type ChipItem } from "./forms/Chips";
export { SegmentedControl, type SegmentedControlProps, type SegmentItem } from "./forms/SegmentedControl";
export { SearchInput, type SearchInputProps } from "./forms/SearchInput";
export { Field, type FieldProps, type FieldControlProps } from "./forms/Field";
export { ConfirmByTyping, type ConfirmByTypingProps } from "./forms/ConfirmByTyping";

// feedback
export { ToastProvider, useToast, type ToastInput, type ToastTone } from "./feedback/Toast";
export { Skeleton, type SkeletonProps } from "./feedback/Skeleton";
export { EmptyState, type EmptyStateProps } from "./feedback/EmptyState";
export { ErrorState, type ErrorStateProps } from "./feedback/ErrorState";
export { StaleBanner, type StaleBannerProps } from "./feedback/StaleBanner";
