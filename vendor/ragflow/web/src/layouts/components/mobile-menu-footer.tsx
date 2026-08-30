type MobileMenuFooterProps = {
  onClose: () => void;
};

export function MobileMenuFooter({ onClose }: MobileMenuFooterProps) {
  return (
    <div className="shrink-0 border-t border-border-button px-4 py-4">
      <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-sm">
        <button
          type="button"
          onClick={onClose}
          className="text-text-secondary transition-colors hover:text-text-primary"
        >
          ShopMind
        </button>
      </div>
    </div>
  );
}
