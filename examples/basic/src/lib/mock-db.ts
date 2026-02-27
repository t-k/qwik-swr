// In-memory mock database for demo purposes

export interface User {
  id: number;
  name: string;
  email: string;
}

export interface Post {
  id: number;
  title: string;
  body: string;
}

export interface Todo {
  id: number;
  title: string;
  completed: boolean;
}

export interface Message {
  id: number;
  text: string;
  user: string;
  timestamp: number;
}

const users: User[] = Array.from({ length: 20 }, (_, i) => ({
  id: i + 1,
  name: `User ${i + 1}`,
  email: `user${i + 1}@example.com`,
}));

const posts: Post[] = [
  { id: 1, title: "Getting Started with Qwik", body: "Qwik is a resumable framework..." },
  { id: 2, title: "SWR Pattern Explained", body: "Stale-While-Revalidate is a cache strategy..." },
  { id: 3, title: "Building Fast UIs", body: "Performance matters for user experience..." },
  {
    id: 4,
    title: "Data Fetching Best Practices",
    body: "Deduplicate requests and manage cache...",
  },
  { id: 5, title: "TypeScript Tips", body: "Use generics for type-safe data fetching..." },
];

export function getUsers(
  page: number,
  perPage = 5,
): { data: User[]; total: number; page: number; totalPages: number } {
  const start = (page - 1) * perPage;
  const data = users.slice(start, start + perPage);
  return {
    data,
    total: users.length,
    page,
    totalPages: Math.ceil(users.length / perPage),
  };
}

export function getUser(id: number): User | null {
  return users.find((u) => u.id === id) ?? null;
}

export function getPosts(): Post[] {
  return [...posts];
}

export function updateUser(id: number, update: Partial<Pick<User, "name" | "email">>): User | null {
  const user = users.find((u) => u.id === id);
  if (!user) return null;
  if (update.name !== undefined) user.name = update.name;
  if (update.email !== undefined) user.email = update.email;
  return { ...user };
}

// ── Todos ──

const todos: Todo[] = [
  { id: 1, title: "Learn Qwik", completed: true },
  { id: 2, title: "Build SWR library", completed: true },
  { id: 3, title: "Write tests", completed: false },
  { id: 4, title: "Add documentation", completed: false },
];

let todoNextId = 5;

export function getTodos(): Todo[] {
  return [...todos];
}

export function addTodo(title: string): Todo {
  const todo: Todo = { id: todoNextId++, title, completed: false };
  todos.push(todo);
  return todo;
}

export function deleteTodo(id: number): boolean {
  const idx = todos.findIndex((t) => t.id === id);
  if (idx === -1) return false;
  todos.splice(idx, 1);
  return true;
}

export function toggleTodo(id: number): Todo | null {
  const todo = todos.find((t) => t.id === id);
  if (!todo) return null;
  todo.completed = !todo.completed;
  return { ...todo };
}

// ── Messages ──

const messages: Message[] = [
  { id: 1, text: "Welcome to the chat!", user: "System", timestamp: Date.now() - 60000 },
  { id: 2, text: "Hello everyone!", user: "Alice", timestamp: Date.now() - 30000 },
  { id: 3, text: "Hey Alice!", user: "Bob", timestamp: Date.now() - 10000 },
];

export function getMessages(): Message[] {
  return [...messages];
}

// Track call count for error endpoint
let errorCallCount = 0;

export function getErrorCallCount(): number {
  return errorCallCount;
}

export function incrementErrorCallCount(): number {
  return ++errorCallCount;
}

export function resetErrorCallCount(): void {
  errorCallCount = 0;
}
