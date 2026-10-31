import React from 'react';
import { Tabs, navigate } from '../ui';

/**
 * 任务 / 触发器 are two views of the same object graph. Keeping them as tabs of
 * one page matches the sidebar entry ("任务") and the page title ("任务与触发"):
 * the tasks list answers "what runs", the trigger list answers "what makes it
 * run", and neither is buried inside a single task.
 */
export function TaskTabs({ active, counts }: { active: 'tasks' | 'triggers' | 'dsh'; counts?: { tasks?: number; triggers?: number } }) {
  return (
    <Tabs
      tabs={[
        { id: 'tasks', label: counts?.tasks === undefined ? '任务列表' : `任务列表（${counts.tasks}）` },
        { id: 'dsh', label: '关联已有 DSH 会话' },
        { id: 'triggers', label: counts?.triggers === undefined ? '触发器' : `触发器（${counts.triggers}）` },
      ]}
      active={active}
      onChange={(id) => navigate(id === 'tasks' ? '/tasks' : id === 'dsh' ? '/tasks/dsh' : '/tasks/triggers')}
    />
  );
}
