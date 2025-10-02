import React, { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow, format } from 'date-fns';
import { apiRequest } from '@/lib/queryClient';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Mail, Inbox, Send, FileText, Archive, Star, Search, Plus, Paperclip, Reply, ReplyAll, Forward, Trash2, MoveVertical as MoreVertical, Settings, RefreshCw, Check, X, User, Clock, Tag, Filter, Import as SortAsc, ChevronDown, ChevronRight, AtSign } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import ComposeDialog from './compose-dialog';

interface EmailAccount {
  id: string;
  accountName: string;
  emailAddress: string;
  provider: 'gmail' | 'outlook' | 'smtp';
  isDefault: boolean;
  isActive: boolean;
  syncEnabled: boolean;
  lastSyncAt: Date | null;
}

interface EmailMessage {
  id: string;
  subject: string;
  fromEmail: string;
  toEmails: string[];
  ccEmails: string[];
  htmlBody: string | null;
  textBody: string | null;
  sentAt: Date | null;
  isRead: boolean;
  isStarred: boolean;
  threadId: string;
  attachments?: any[];
}

interface EmailThread {
  id: string;
  subject: string;
  participantEmails: string[];
  lastMessageAt: Date | null;
  messageCount: number;
  isArchived: boolean | null;
  labels: string[];
  messages?: EmailMessage[];
  preview?: string;
}

const FOLDERS = [
  { id: 'inbox', name: 'Inbox', icon: Inbox, count: 0 },
  { id: 'sent', name: 'Sent', icon: Send, count: 0 },
  { id: 'drafts', name: 'Drafts', icon: FileText, count: 0 },
  { id: 'archived', name: 'Archived', icon: Archive, count: 0 },
];

const LABELS = [
  { id: 'important', name: 'Important', color: 'bg-red-500' },
  { id: 'work', name: 'Work', color: 'bg-blue-500' },
  { id: 'personal', name: 'Personal', color: 'bg-green-500' },
  { id: 'follow-up', name: 'Follow-up', color: 'bg-yellow-500' },
];

export default function ModernEmailClient() {
  const [selectedFolder, setSelectedFolder] = useState('inbox');
  const [selectedThread, setSelectedThread] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [composeOpen, setComposeOpen] = useState(false);
  const [accountsDialogOpen, setAccountsDialogOpen] = useState(false);
  const [selectedThreads, setSelectedThreads] = useState<Set<string>>(new Set());
  const [bulkActionMode, setBulkActionMode] = useState(false);
  const [replyData, setReplyData] = useState<any>(null);
  const [composeMode, setComposeMode] = useState<'compose' | 'reply' | 'reply-all' | 'forward'>('compose');
  
  const queryClient = useQueryClient();

  // Fetch email accounts
  const { data: emailAccounts = [], isLoading: accountsLoading } = useQuery<EmailAccount[]>({
    queryKey: ['/api/marketing/email-accounts'],
    queryFn: async () => {
      try {
        const response = await apiRequest('GET', '/api/marketing/email-accounts');
        if (!response.ok) return [];
        return response.json();
      } catch {
        return [] as EmailAccount[];
      }
    },
    retry: false,
  });

  // Fetch email threads with auto-refresh every 30 seconds
  const { data: emailThreads = [], isLoading: threadsLoading, refetch: refetchThreads } = useQuery<EmailThread[]>({
    queryKey: ['/api/marketing/emails/threads', selectedFolder, searchQuery],
    queryFn: async () => {
      try {
        if (searchQuery.trim()) {
          const response = await apiRequest('GET', `/api/marketing/emails/search?q=${encodeURIComponent(searchQuery)}&limit=50`);
          if (!response.ok) return [] as EmailThread[];
          const data = await response.json();
          return data.threads || [];
        } else {
          const response = await apiRequest('GET', `/api/marketing/emails/threads?type=${selectedFolder}&limit=50`);
          if (!response.ok) return [] as EmailThread[];
          return response.json();
        }
      } catch {
        return [] as EmailThread[];
      }
    },
    refetchInterval: 30000, // Auto-refresh every 30 seconds
    refetchOnWindowFocus: true,
    staleTime: 15000, // Consider data stale after 15 seconds
    retry: 1,
  });

  // Fetch messages for selected thread
  const { data: threadMessages = [] } = useQuery<EmailMessage[]>({
    queryKey: ['/api/marketing/emails/threads', selectedThread, 'messages'],
    queryFn: async () => {
      try {
        if (!selectedThread) return [] as EmailMessage[];
        const response = await apiRequest('GET', `/api/marketing/emails/threads/${selectedThread}/messages`);
        if (!response.ok) return [] as EmailMessage[];
        return response.json();
      } catch {
        return [] as EmailMessage[];
      }
    },
    enabled: !!selectedThread,
    retry: false,
  });

  // OAuth handlers
  const handleGmailOAuth = async () => {
    try {
      const response = await apiRequest('GET', '/api/marketing/oauth/gmail/auth');
      if (response.ok) {
        const { authUrl } = await response.json();
        const popup = window.open(authUrl, 'gmail-oauth', 'width=500,height=600,scrollbars=yes,resizable=yes');
        
        const handleMessage = async (event: MessageEvent) => {
          if (event.data.type === 'GMAIL_OAUTH_SUCCESS') {
            queryClient.invalidateQueries({ queryKey: ['/api/marketing/email-accounts'] });
            window.removeEventListener('message', handleMessage);
            popup?.close();
            toast.success('Gmail account connected successfully!');
            
            // Auto-sync emails after successful connection
            setTimeout(async () => {
              try {
                const accountsResponse = await apiRequest('GET', '/api/marketing/email-accounts');
                if (accountsResponse.ok) {
                  const accounts = await accountsResponse.json();
                  const newAccount = accounts.find((acc: EmailAccount) => acc.provider === 'gmail');
                  if (newAccount) {
                    toast.info('Syncing emails from Gmail...');
                    syncMutation.mutate(newAccount.id);
                  }
                }
              } catch (error) {
                console.error('Auto-sync failed:', error);
              }
            }, 1000);
          }
        };
        
        window.addEventListener('message', handleMessage);
      }
    } catch (error) {
      toast.error('Failed to connect Gmail account');
    }
  };

  const handleOutlookOAuth = async () => {
    try {
      const response = await apiRequest('GET', '/api/marketing/oauth/outlook/auth');
      if (response.ok) {
        const { authUrl } = await response.json();
        const popup = window.open(authUrl, 'outlook-oauth', 'width=500,height=600,scrollbars=yes,resizable=yes');
        
        const handleMessage = async (event: MessageEvent) => {
          if (event.data.type === 'OUTLOOK_OAUTH_SUCCESS') {
            queryClient.invalidateQueries({ queryKey: ['/api/marketing/email-accounts'] });
            window.removeEventListener('message', handleMessage);
            popup?.close();
            toast.success('Outlook account connected successfully!');
            
            // Auto-sync emails after successful connection
            setTimeout(async () => {
              try {
                const accountsResponse = await apiRequest('GET', '/api/marketing/email-accounts');
                if (accountsResponse.ok) {
                  const accounts = await accountsResponse.json();
                  const newAccount = accounts.find((acc: EmailAccount) => acc.provider === 'outlook');
                  if (newAccount) {
                    toast.info('Syncing emails from Outlook...');
                    syncMutation.mutate(newAccount.id);
                  }
                }
              } catch (error) {
                console.error('Auto-sync failed:', error);
              }
            }, 1000);
          }
        };
        
        window.addEventListener('message', handleMessage);
      }
    } catch (error) {
      toast.error('Failed to connect Outlook account');
    }
  };

  // Sync account
  const syncMutation = useMutation({
    mutationFn: async (accountId: string) => {
      const response = await apiRequest('POST', `/api/marketing/email-accounts/${accountId}/sync`);
      if (!response.ok) throw new Error('Sync failed');
      return response.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['/api/marketing/emails/threads'] });
      queryClient.invalidateQueries({ queryKey: ['/api/marketing/email-accounts'] });
      const count = data.syncedCount || 0;
      if (count > 0) {
        toast.success(`Synced ${count} new email${count === 1 ? '' : 's'}!`);
      } else {
        toast.info('Already up to date');
      }
    },
    onError: (error: any) => {
      toast.error(error?.message || 'Failed to sync emails');
    },
  });

  const getInitials = (email: string) => {
    return email.split('@')[0].slice(0, 2).toUpperCase();
  };

  const formatEmailPreview = (message: EmailMessage) => {
    const text = message.textBody || message.htmlBody?.replace(/<[^>]*>/g, '') || '';
    return text.slice(0, 100) + (text.length > 100 ? '...' : '');
  };

  const handleReply = (mode: 'reply' | 'reply-all' | 'forward') => {
    const selectedThreadData = emailThreads.find(t => t.id === selectedThread);
    const latestMessage = threadMessages[threadMessages.length - 1];
    
    if (selectedThreadData && latestMessage) {
      setReplyData({
        threadId: selectedThread,
        subject: selectedThreadData.subject,
        fromEmail: latestMessage.fromEmail,
        toEmails: latestMessage.toEmails,
        ccEmails: latestMessage.ccEmails,
      });
      setComposeMode(mode);
      setComposeOpen(true);
    }
  };

  const handleCompose = () => {
    setReplyData(null);
    setComposeMode('compose');
    setComposeOpen(true);
  };

  return (
    <TooltipProvider>
  <div className="flex h-[800px] bg-gradient-to-br from-slate-50 to-slate-100 rounded-xl overflow-hidden border border-slate-200 shadow-lg">
        {/* Sidebar */}
        <div className={cn(
          "bg-white/95 backdrop-blur-sm border-r border-slate-200 flex flex-col transition-all duration-300 shadow-sm",
          sidebarCollapsed ? "w-16" : "w-64"
        )}>
          {/* Header */}
          <div className={cn("border-b border-slate-200 bg-gradient-to-b from-white to-slate-50", sidebarCollapsed ? "p-2" : "p-4")}>
            <div className={cn("flex items-center justify-between", sidebarCollapsed ? "mb-2" : "mb-4")}>
              {!sidebarCollapsed && <h2 className="text-lg font-semibold bg-gradient-to-r from-slate-900 to-slate-700 bg-clip-text text-transparent">Mail</h2>}
              <div className="flex gap-1">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => setSidebarCollapsed((v) => !v)}
                      aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
                      className={cn(
                        "transition-all rounded-full p-2 flex items-center justify-center border border-gray-200 bg-gray-100 hover:bg-blue-100 hover:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-400",
                        sidebarCollapsed ? "shadow-md" : "shadow"
                      )}
                      style={{ minWidth: 36, minHeight: 36 }}
                    >
                      {sidebarCollapsed ? <ChevronRight className="h-5 w-5 text-blue-600" /> : <ChevronDown className="h-5 w-5 text-blue-600" />}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>{sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => refetchThreads()}
                      disabled={threadsLoading}
                    >
                      <RefreshCw className={cn("h-4 w-4", threadsLoading && "animate-spin")} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Refresh</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setAccountsDialogOpen(true)}
                    >
                      <Settings className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Account Settings</TooltipContent>
                </Tooltip>
              </div>
            </div>
            
            {!sidebarCollapsed && (
              <Button
                onClick={handleCompose}
                className="w-full bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-700 hover:to-blue-800 shadow-md hover:shadow-lg transition-all"
              >
                <Plus className="h-4 w-4 mr-2" />
                Compose
              </Button>
            )}
          </div>

          {/* Folders */}
          <div className="flex-1 overflow-hidden">
            <ScrollArea className="h-full">
              {/* Folders */}
              <div className={cn("space-y-1 flex flex-col items-stretch", sidebarCollapsed ? "p-1" : "p-2")}> 
                {FOLDERS.map((folder) => (
                  <Tooltip key={folder.id}>
                    <TooltipTrigger asChild>
                      <Button
                        variant={selectedFolder === folder.id ? "secondary" : "ghost"}
                        className={cn(
                          "justify-center h-10 transition-all duration-300 flex items-center",
                          sidebarCollapsed ? "w-12 p-0 mx-auto" : "w-full",
                          selectedFolder === folder.id && "bg-blue-50 text-blue-700 border-r-2 border-blue-600"
                        )}
                        onClick={() => setSelectedFolder(folder.id)}
                      >
                        <folder.icon className="h-5 w-5" />
                        {!sidebarCollapsed && <span className="flex-1 text-left ml-2">{folder.name}</span>}
                        {!sidebarCollapsed && folder.count > 0 && (
                          <Badge variant="secondary" className="ml-auto text-xs">
                            {folder.count}
                          </Badge>
                        )}
                      </Button>
                    </TooltipTrigger>
                    {sidebarCollapsed && <TooltipContent>{folder.name}</TooltipContent>}
                  </Tooltip>
                ))}
              </div>

              <Separator className="my-4" />

              {/* Labels */}
              <div className={cn(sidebarCollapsed ? "flex flex-col items-center gap-3" : "px-2 pb-2")}> 
                {!sidebarCollapsed && <div className="text-xs font-medium text-gray-500 mb-2 px-2">Labels</div>}
                <div className={cn(sidebarCollapsed ? "flex flex-col gap-3" : "space-y-1")}> 
                  {LABELS.map((label) => (
                    <Tooltip key={label.id}>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          className={cn(
                            sidebarCollapsed ? "w-10 h-10 p-0 mx-auto flex items-center justify-center" : "w-full justify-start h-8 text-sm"
                          )}
                        >
                          <div className={cn("w-3 h-3 rounded-full", label.color, sidebarCollapsed ? "mr-0" : "mr-3")} />
                          {!sidebarCollapsed && label.name}
                        </Button>
                      </TooltipTrigger>
                      {sidebarCollapsed && <TooltipContent>{label.name}</TooltipContent>}
                    </Tooltip>
                  ))}
                </div>
              </div>

              <Separator className="my-4" />

              {/* Accounts */}
              <div className={cn(sidebarCollapsed ? "flex flex-col items-center gap-3" : "px-2 pb-2")}> 
                {!sidebarCollapsed && <div className="text-xs font-medium text-gray-500 mb-2 px-2">Accounts ({emailAccounts.length})</div>}
                <div className={cn(sidebarCollapsed ? "flex flex-col gap-3" : "space-y-1")}> 
                  {emailAccounts.map((account) => (
                    <Tooltip key={account.id}>
                      <TooltipTrigger asChild>
                        <div
                          className={cn(
                            "rounded-md hover:bg-gray-50 flex items-center justify-center cursor-pointer",
                            sidebarCollapsed ? "w-10 h-10 mx-auto" : "p-2"
                          )}
                          onClick={() => setAccountsDialogOpen(true)}
                        >
                          {account.provider === 'gmail' ? (
                            <Mail className="h-5 w-5 text-red-500" />
                          ) : (
                            <AtSign className="h-5 w-5 text-blue-500" />
                          )}
                          {!sidebarCollapsed && (
                            <div className="ml-2 min-w-0">
                              <div className="text-xs font-medium text-gray-900 truncate">
                                {account.accountName}
                              </div>
                              <div className="text-xs text-gray-500 truncate">
                                {account.emailAddress}
                              </div>
                            </div>
                          )}
                        </div>
                      </TooltipTrigger>
                      {sidebarCollapsed && <TooltipContent>{account.accountName}<br />{account.emailAddress}</TooltipContent>}
                    </Tooltip>
                  ))}
                  {emailAccounts.length === 0 && !sidebarCollapsed && (
                    <div className="text-center py-4">
                      <p className="text-sm text-gray-500 mb-2">No accounts connected</p>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setAccountsDialogOpen(true)}
                      >
                        Add Account
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            </ScrollArea>
          </div>
        </div>

  {/* Main Content */}
  <div className="flex-1 flex flex-col bg-gradient-to-br from-slate-50 to-white">
          {/* Search Bar */}
          <div className="p-4 border-b border-slate-200 bg-white/90 backdrop-blur-sm shadow-sm">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
              <Input
                placeholder="Search emails..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-10 pr-4"
              />
            </div>
          </div>

          <div className="flex-1 flex">
            {/* Email List */}
            <div className={cn("transition-all duration-300 border-r border-slate-200 bg-white/50 backdrop-blur-sm", sidebarCollapsed ? "w-0 min-w-0" : "w-[28rem] min-w-[24rem]")}>
              {/* List Header */}
              <div className="p-3 border-b border-slate-200 bg-gradient-to-r from-white to-slate-50">
                <div className="flex items-center gap-2">
                  {bulkActionMode && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setSelectedThreads(new Set());
                        setBulkActionMode(false);
                      }}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  )}
                  <h3 className="font-medium capitalize">{selectedFolder}</h3>
                  <Badge variant="secondary" className="text-xs">
                    {emailThreads.length}
                  </Badge>
                </div>
                
                <div className="flex items-center gap-1">
                  {selectedThreads.size > 0 && (
                    <Button variant="ghost" size="sm">
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="sm">
                        <SortAsc className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem>Date (newest first)</DropdownMenuItem>
                      <DropdownMenuItem>Date (oldest first)</DropdownMenuItem>
                      <DropdownMenuItem>Sender</DropdownMenuItem>
                      <DropdownMenuItem>Subject</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>

              {/* Email Threads */}
              <ScrollArea className="h-[calc(100%-60px)] pr-1">
                {threadsLoading ? (
                  <div className="p-8 text-center">
                    <div className="relative">
                      <div className="absolute inset-0 flex items-center justify-center">
                        <div className="h-12 w-12 rounded-full bg-gradient-to-r from-blue-400 to-blue-600 animate-pulse"></div>
                      </div>
                      <RefreshCw className="h-6 w-6 animate-spin mx-auto mb-2 text-blue-600 relative z-10" />
                    </div>
                    <p className="text-sm text-slate-600 mt-4 font-medium">Loading emails...</p>
                  </div>
                ) : emailThreads.length === 0 ? (
                  <div className="p-8 text-center">
                    <div className="h-16 w-16 mx-auto mb-4 rounded-full bg-gradient-to-br from-slate-100 to-slate-200 flex items-center justify-center">
                      <Mail className="h-8 w-8 text-slate-400" />
                    </div>
                    <p className="text-sm text-slate-600 font-medium mb-2">
                      {searchQuery ? 'No emails found' : 'No emails in this folder'}
                    </p>
                    <p className="text-xs text-slate-500 mb-4">
                      {searchQuery ? 'Try a different search term' : 'Your mailbox is empty'}
                    </p>
                    {!searchQuery && emailAccounts.length > 0 && (
                      <div className="space-y-2">
                        <p className="text-xs text-gray-400">
                          Connected accounts need to be synced to show emails
                        </p>
                        <div className="flex flex-wrap gap-2 justify-center">
                          {emailAccounts.map((account) => (
                            <Button
                              key={account.id}
                              variant="outline"
                              size="sm"
                              onClick={() => syncMutation.mutate(account.id)}
                              disabled={syncMutation.isPending}
                              className="text-xs"
                            >
                              <RefreshCw className={cn("h-3 w-3 mr-1", syncMutation.isPending && "animate-spin")} />
                              Sync {account.accountName}
                            </Button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="flex flex-col gap-2 py-2 px-2">
                    {emailThreads.map((thread) => (
                      <div
                        key={thread.id}
                        className={cn(
                          "group flex items-center px-3 py-3 bg-white rounded-xl border cursor-pointer transition-all duration-200",
                          selectedThread === thread.id
                            ? "bg-gradient-to-r from-blue-50 to-indigo-50 border-blue-400 shadow-md ring-2 ring-blue-200"
                            : "border-slate-200 hover:shadow-lg hover:border-blue-300 hover:bg-slate-50"
                        )}
                        style={{ minHeight: 76 }}
                        onClick={() => setSelectedThread(thread.id)}
                      >
                        <input
                          type="checkbox"
                          className="mr-3 accent-blue-500 h-4 w-4 mt-1"
                          checked={selectedThreads.has(thread.id)}
                          onChange={(e) => {
                            const newSelected = new Set(selectedThreads);
                            if (e.target.checked) {
                              newSelected.add(thread.id);
                            } else {
                              newSelected.delete(thread.id);
                            }
                            setSelectedThreads(newSelected);
                          }}
                          onClick={(e) => e.stopPropagation()}
                        />
                        <button
                          className="mr-3 text-gray-300 group-hover:text-yellow-400 focus:outline-none"
                          tabIndex={-1}
                          onClick={e => e.stopPropagation()}
                          aria-label="Star"
                        >
                          <Star className="h-5 w-5" />
                        </button>
                        <Avatar className="h-9 w-9 flex-shrink-0 mr-3">
                          <AvatarFallback className="bg-gray-200 text-gray-600 text-xs">
                            {getInitials(thread.participantEmails[0] || 'U')}
                          </AvatarFallback>
                        </Avatar>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between">
                            <span className="font-semibold text-gray-900 text-sm truncate">
                              {thread.participantEmails[0]?.split('@')[0] || 'Unknown'}
                            </span>
                            <span className="text-xs text-gray-500 flex-shrink-0 ml-2">
                              {thread.lastMessageAt && formatDistanceToNow(new Date(thread.lastMessageAt), { addSuffix: true })}
                            </span>
                          </div>
                          <div className="flex items-center gap-2 mt-1">
                            <span className="text-sm text-gray-800 font-medium truncate max-w-[12rem]">
                              {thread.subject || '(no subject)'}
                            </span>
                            {thread.messageCount > 1 && (
                              <Badge variant="outline" className="text-xs ml-1">
                                {thread.messageCount}
                              </Badge>
                            )}
                          </div>
                          <div className="text-xs text-gray-500 truncate max-w-[16rem] mt-0.5">
                            {thread.preview || 'No preview available'}
                          </div>
                          <div className="flex items-center gap-2 mt-1">
                            {thread.labels.map((label) => (
                              <Badge key={label} variant="secondary" className="text-xs">
                                {label}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </ScrollArea>
            </div>

            {/* Email Content */}
            <div className="flex-1 bg-gradient-to-br from-white to-slate-50" style={{ minWidth: 0 }}>
              {selectedThread ? (
                <div className="h-full flex flex-col px-0 md:px-8 py-4">
                  {/* Email Header */}
                  <div className="p-6 border-b border-slate-200 bg-white rounded-t-xl shadow-md mb-4 backdrop-blur-sm">
                    <div className="flex items-center justify-between mb-2">
                      <h2 className="text-lg font-semibold text-gray-900">
                        {threadMessages[0]?.subject || '(no subject)'}
                      </h2>
                      <div className="flex items-center gap-1">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button variant="ghost" size="sm">
                              <Star className="h-4 w-4" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Star</TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button variant="ghost" size="sm">
                              <Archive className="h-4 w-4" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Archive</TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button variant="ghost" size="sm">
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Delete</TooltipContent>
                        </Tooltip>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="sm">
                              <MoreVertical className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem>Mark as unread</DropdownMenuItem>
                            <DropdownMenuItem>Add label</DropdownMenuItem>
                            <DropdownMenuItem>Move to folder</DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </div>
                    
                    <div className="flex items-center gap-4">
                      <Button 
                        variant="outline" 
                        size="sm"
                        onClick={() => handleReply('reply')}
                      >
                        <Reply className="h-4 w-4 mr-2" />
                        Reply
                      </Button>
                      <Button 
                        variant="outline" 
                        size="sm"
                        onClick={() => handleReply('reply-all')}
                      >
                        <ReplyAll className="h-4 w-4 mr-2" />
                        Reply All
                      </Button>
                      <Button 
                        variant="outline" 
                        size="sm"
                        onClick={() => handleReply('forward')}
                      >
                        <Forward className="h-4 w-4 mr-2" />
                        Forward
                      </Button>
                    </div>
                  </div>

                  {/* Messages */}
                  <ScrollArea className="flex-1">
                    <div className="space-y-6">
                      {threadMessages.map((message) => (
                        <Card key={message.id} className="border-l-4 border-l-blue-500 bg-white shadow-lg rounded-xl hover:shadow-xl transition-shadow">
                          <CardContent className="p-8">
                            <div className="flex items-start justify-between mb-6">
                              <div className="flex items-center gap-3">
                                <Avatar className="h-8 w-8">
                                  <AvatarFallback className="bg-blue-100 text-blue-600 text-xs">
                                    {getInitials(message.fromEmail)}
                                  </AvatarFallback>
                                </Avatar>
                                <div>
                                  <div className="font-medium text-base text-gray-900 mb-1">
                                    {message.fromEmail}
                                  </div>
                                  <div className="text-xs text-gray-500">
                                    to {message.toEmails.join(', ')}
                                  </div>
                                </div>
                              </div>
                              <div className="text-xs text-gray-500 whitespace-nowrap ml-4">
                                {message.sentAt && format(new Date(message.sentAt), 'MMM d, yyyy h:mm a')}
                              </div>
                            </div>
                            
                            <div className="prose prose-base max-w-none bg-gray-50 rounded-lg p-6 my-4">
                              {message.htmlBody ? (
                                <div dangerouslySetInnerHTML={{ __html: message.htmlBody }} />
                              ) : (
                                <p className="whitespace-pre-wrap">{message.textBody}</p>
                              )}
                            </div>
                            
                            {message.attachments && message.attachments.length > 0 && (
                              <div className="mt-8 pt-6 border-t border-gray-200">
                                <div className="flex items-center gap-3 mb-3">
                                  <Paperclip className="h-5 w-5 text-gray-400" />
                                  <span className="text-base text-gray-700 font-medium">
                                    {message.attachments.length} attachment(s)
                                  </span>
                                </div>
                                <div className="flex flex-wrap gap-4">
                                  {message.attachments.map((attachment, index) => (
                                    <Badge key={index} variant="outline" className="px-4 py-2 text-sm">
                                      {attachment.fileName || `Attachment ${index + 1}`}
                                    </Badge>
                                  ))}
                                </div>
                              </div>
                            )}
  // Collapsible sidebar state
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
                          </CardContent>
                        </Card>
                      ))}
                    </div>
                  </ScrollArea>
                </div>
              ) : (
                <div className="h-full flex items-center justify-center">
                  <div className="text-center animate-in fade-in duration-500">
                    <div className="h-20 w-20 mx-auto mb-6 rounded-2xl bg-gradient-to-br from-slate-100 to-slate-200 flex items-center justify-center shadow-md">
                      <Mail className="h-10 w-10 text-slate-400" />
                    </div>
                    <h3 className="text-xl font-semibold text-slate-800 mb-2">Select an email</h3>
                    <p className="text-slate-500 max-w-sm mx-auto">Choose an email from the list to view its content and start a conversation</p>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Account Management Dialog */}
        <Dialog open={accountsDialogOpen} onOpenChange={setAccountsDialogOpen}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Email Accounts</DialogTitle>
              <DialogDescription className="sr-only">Manage your connected email accounts and sync settings</DialogDescription>
            </DialogHeader>
            
            <div className="space-y-4">
              <div className="space-y-2">
                <h4 className="font-medium">Connected Accounts</h4>
                <div className="flex flex-col gap-2">
                  {emailAccounts.length === 0 ? (
                    <p className="text-sm text-gray-500">No accounts connected</p>
                  ) : (
                    <div className="space-y-2">
                      {emailAccounts.map((account) => (
                        <div key={account.id} className="flex items-center justify-between p-2 border rounded">
                          <div className="flex items-center gap-2">
                            {account.provider === 'gmail' ? (
                              <Mail className="h-4 w-4 text-red-500" />
                            ) : (
                              <AtSign className="h-4 w-4 text-blue-500" />
                            )}
                            <div>
                              <div className="text-sm font-medium">{account.accountName}</div>
                              <div className="text-xs text-gray-500">{account.emailAddress}</div>
                            </div>
                          </div>
                          <Badge variant={account.isActive ? "default" : "secondary"}>
                            {account.isActive ? "Active" : "Inactive"}
                          </Badge>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              
              <Separator />
              
              <div className="space-y-2">
                <h4 className="font-medium">Add New Account</h4>
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    variant="outline"
                    onClick={handleGmailOAuth}
                    className="flex items-center gap-2"
                  >
                    <Mail className="h-4 w-4 text-red-500" />
                    Gmail
                  </Button>
                  <Button
                    variant="outline"
                    onClick={handleOutlookOAuth}
                    className="flex items-center gap-2"
                  >
                    <AtSign className="h-4 w-4 text-blue-500" />
                    Outlook
                  </Button>
                </div>
              </div>
            </div>
          </DialogContent>
        </Dialog>

        {/* Compose Dialog */}
        <ComposeDialog
          open={composeOpen}
          onOpenChange={setComposeOpen}
          replyTo={replyData}
          mode={composeMode}
        />
      </div>
    </TooltipProvider>
  );
}
