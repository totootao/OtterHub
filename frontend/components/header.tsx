"use client";

import { Search, X, Settings2 } from "lucide-react";
import { useFileQueryStore } from "@/stores/file";
import { useIsMobile } from "@/hooks/use-mobile";
import { Button } from "./ui/button";
import { FileTypeDropdown } from "./FileTypeDropdown";
import { FileTypeTabs } from "./FileTypeTabs";
import { ImageLoadModeToggle } from "./ImageLoadModeToggle";
import { SafeModeToggle } from "./SafeModeToggle";
import { ThemeToggle } from "./ThemeToggle";
import { Input } from "./ui/input";
import {
  Sheet,
  SheetTrigger,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "./ui/sheet";
import { APP_NAME, APP_CATEGORY } from "@/lib/ui-text";
import { OPEN_GLOBAL_SEARCH_EVENT } from "./GlobalSearchDialog";

/** 打开全局搜索对话框（跨类型检索），可携带初始关键词 */
const openGlobalSearch = (q?: string) =>
  window.dispatchEvent(
    new CustomEvent(OPEN_GLOBAL_SEARCH_EVENT, q ? { detail: { q } } : undefined)
  );

export function Header() {
  const { searchQuery, setSearchQuery } = useFileQueryStore();
  const isMobile = useIsMobile();

  // 移动端头部导航栏
  if (isMobile) {
    return (
      <header className="sticky top-0 z-40 w-full border-b border-glass-border bg-glass-bg/80 backdrop-blur-xl">
        <div className="flex h-16 items-center px-4">
          <div className="flex w-full items-center justify-between animate-in fade-in duration-300">
            <div className="flex items-center gap-2.5">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-linear-to-br from-primary to-accent text-xl shadow-lg shadow-primary/20">
                🦦
              </div>
              <span className="text-lg font-bold tracking-tight text-foreground">
                {APP_NAME}
              </span>
            </div>
            <div className="flex items-center gap-1">
              <FileTypeDropdown />
              <Button
                variant="ghost"
                size="icon"
                onClick={() => openGlobalSearch()}
                title="全局搜索"
                className="h-10 w-10 text-foreground/70 rounded-xl"
              >
                <Search className="h-5 w-5" />
              </Button>
              <Sheet>
                <SheetTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-10 w-10 text-foreground/70 rounded-xl"
                  >
                    <Settings2 className="h-5 w-5" />
                  </Button>
                </SheetTrigger>
                <SheetContent
                  side="bottom"
                  className="rounded-t-[2.5rem] border-glass-border bg-popover/95 backdrop-blur-2xl pb-12 px-8"
                >
                  <SheetHeader className="mb-2 pt-2">
                    <div className="mx-auto w-12 h-1.5 rounded-full bg-foreground/10 mb-6" />
                    <SheetTitle className="text-xl font-bold text-foreground flex items-center gap-3">
                      <div className="p-2 rounded-lg bg-primary/10">
                        <Settings2 className="h-5 w-5 text-primary" />
                      </div>
                      偏好设置
                    </SheetTitle>
                  </SheetHeader>
                  <div className="space-y-8">
                    <div className="flex items-center justify-between">
                      <div className="space-y-1">
                        <p className="text-base font-semibold text-foreground">
                          安全模式
                        </p>
                        <p className="text-xs text-foreground/50">
                          遮罩敏感内容 (NSFW)
                        </p>
                      </div>
                      <SafeModeToggle />
                    </div>
                    <div className="flex items-center justify-between">
                      <div className="space-y-1">
                        <p className="text-base font-semibold text-foreground">
                          图片加载
                        </p>
                        <p className="text-xs text-foreground/50">
                          根据网络自动调整质量
                        </p>
                      </div>
                      <ImageLoadModeToggle />
                    </div>
                    <div className="flex items-center justify-between">
                      <div className="space-y-1">
                        <p className="text-base font-semibold text-foreground">
                          深色模式
                        </p>
                        <p className="text-xs text-foreground/50">
                          随系统自动切换主题
                        </p>
                      </div>
                      <ThemeToggle />
                    </div>
                  </div>
                </SheetContent>
              </Sheet>
            </div>
          </div>
        </div>
      </header>
    );
  }

  // 桌面端头部导航栏
  return (
    <header className="sticky top-0 z-40 w-full border-b border-glass-border bg-glass-bg/70 backdrop-blur-xl">
      <div className="flex h-20 items-center justify-between px-6 md:px-8">
        {/* Left: Logo */}
        <div
          className="flex items-center gap-4 group cursor-pointer shrink-0"
          title="返回顶部"
          onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
        >
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-linear-to-br from-primary to-accent text-2xl shadow-xl shadow-primary/20 transition-transform group-hover:scale-110">
            🦦
          </div>
          <div className="hidden lg:block">
            <h1 className="text-xl font-black tracking-tighter text-foreground leading-none">
              {APP_NAME}
            </h1>
            <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-primary/60 mt-1">
              {APP_CATEGORY}
            </p>
          </div>
        </div>

        {/* Center: Tabs */}
        <div className="flex-1 flex justify-center px-4">
          <FileTypeTabs />
        </div>

        {/* Right: Actions */}
        <div className="flex items-center gap-3 shrink-0">
          <div className="relative group hidden xl:block">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-foreground/30 group-focus-within:text-primary transition-colors" />
            <Input
              placeholder="搜索文件，回车全局搜索..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && searchQuery.trim()) {
                  openGlobalSearch(searchQuery.trim());
                }
              }}
              className="h-10 w-64 rounded-xl border-glass-border bg-secondary/20 pl-10 pr-14 text-sm focus-visible:ring-primary/40 placeholder:text-foreground/80"
            />
            {searchQuery ? (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setSearchQuery("")}
                className="absolute right-1 top-1/2 -translate-y-1/2 h-8 w-8 text-foreground/30 hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </Button>
            ) : (
              <kbd
                title="全局搜索快捷键"
                className="absolute right-2.5 top-1/2 -translate-y-1/2 hidden items-center rounded-md border border-glass-border bg-secondary/30 px-1.5 py-0.5 text-[10px] font-medium text-foreground/40 md:flex"
              >
                ⌘K
              </kbd>
            )}
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => openGlobalSearch()}
            title="全局搜索 (Ctrl+K)"
            className="h-10 w-10 rounded-xl text-foreground/70 hover:text-foreground xl:hidden"
          >
            <Search className="h-5 w-5" />
          </Button>
          <div className="flex items-center gap-1.5 rounded-2xl bg-secondary/10 p-1.5 border border-glass-border">
            <SafeModeToggle />
            <ImageLoadModeToggle />
            <ThemeToggle />
          </div>
        </div>
      </div>
    </header>
  );
}
