# Java Concurrency Coding Interview Bible 
> A practical Java concurrency interview handbook for Senior Backend Engineers. 
> Learn by implementing, not by memorizing. 


## Overview 
This repository is a collection of **real-world Java concurrency coding intervidew problems** inspired by interviewers from FANNG companies. 

Unlike traditional algorithm repositories, this project focuses on **engineering-oriented concurrency problems** that are frequently asked in backend interviews. 

The goal is not only to solve interview questions, but also to develop the ability to design, implement, analyze, and discuss concurrent systems like a professional software engineer. 


## Chapter 1 Thread Coordination (Classic)
- Q01 Two Threads Alternative Printing (Odd/Even)
- Q02 Two Threads Print ABC Alternatively 
- Q03 Three Threads Print ABCABC...
- Q04 N Threads Print Sequentially (Generalized Version)
- Q05 Print FooBar Alternatively (LC1115)
- Q06 Print in Order (LC1114) 
- Q07 Zero Even Odd (LC1116) 
- Q08 FizzBuzz Multithreaded (LC1195) 



## Chapter 2 Producer Consumer 
- Q9 Producer Consumer (wait/notify)
- Q10 Producer Consumer (Lock + Condition)
- Q11 Producer Consumer (BlockingQueue)
- Q12 Implement BlockingQueue 
- Q13 Bounded BlockingQueue(LC1188)
- Q14 Multiple Producer Multiple Consumer 


## Chapter 3 Thread Pool 
- Q15 Implement Fix ThreadPool 
- Q16 Implement Simple ThreadPoolExecutor 
- Q17 Worker Thread Design 
- Q18 ThreadPool with Future 
- Q19 Graceful Shutdown 
- Q20 Rejection Policy 
- Q21 ExecutorCompletionService Example 

## Chapter 4 Locks 
- Q22 ReentrantLock Example 
- Q23 ReadWriteLock Example 
- Q24 Semaphore Example 
- Q25 CountDownLatch Example 
- Q26 CyclicBarrier Example 
- Q27 Bank Transfer (Deadlock Avoidance)

## Chapter 5 Concurrent Components 
- Q28 Thread-safe Counter 
- Q29 Atomic Counter vs LongAfter 
- Q30 Thread-safe Singleton 
- Q31 Thread-safe LRU Cache 
- Q32 Connection Pool (Semaphore)

## Chapter 6 Future & CompletableFuture 
- Q33 Implement Simple Future 
- Q34 CompletableFuture Pipeline 
- Q35 thenCompose vs thenCombine
- Q36 allOf / anyOf 
- Q37 Timeout & Exception Handling 

## Chapter 7 Rate Limiter 
- Q38 Token Bucket 
- Q39 Sliding Window 
- Q40 Fixed Window 

## Chapter 8 Virtual Threads (Java 21) 
- Q41 Virtual Thread Executor 
- Q42 Virtual Thread Batch Tasks 
- Q43 Virtual Producer Consumer 
- Q44 StructuredTaskScope Example 

## Chapter 9 ForkJoin 
- Q45 Parallel Sum 
- Q46 Parallel Merge Sort 
- Q47 Parallel File Search 

## Chapter 10 Parallel Stream 
- Q48 parallelStream Pitfalls 
- Q49 CompletableFuture + Stream Aggregation 


## Chapter 11 Debugging 
- Q50 Find & Fix Deadlock 
- Q51 ThreadLocal Memory Leak 
- Q53 ThreadPool Queue OOM
- Q54 Future.get() Blocking Issue 