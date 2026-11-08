//! Small async helpers (instead of tokio's `select!`/`join!` macros).

use std::future::{Future, poll_fn};
use std::pin::pin;
use std::task::Poll;

/// The output of [`select2`].
#[derive(Debug)]
pub enum Either<A, B> {
    Left(A),
    Right(B),
}

/// Waits for the first of two futures (biased: `a` is polled first); the
/// other is dropped.
pub async fn select2<A: Future, B: Future>(a: A, b: B) -> Either<A::Output, B::Output> {
    let mut a = pin!(a);
    let mut b = pin!(b);
    poll_fn(|cx| {
        if let Poll::Ready(v) = a.as_mut().poll(cx) {
            return Poll::Ready(Either::Left(v));
        }
        if let Poll::Ready(v) = b.as_mut().poll(cx) {
            return Poll::Ready(Either::Right(v));
        }
        Poll::Pending
    })
    .await
}

/// Runs two futures to completion concurrently.
pub async fn join2<A: Future, B: Future>(a: A, b: B) -> (A::Output, B::Output) {
    let mut a = pin!(a);
    let mut b = pin!(b);
    let mut ra = None;
    let mut rb = None;
    poll_fn(|cx| {
        if ra.is_none()
            && let Poll::Ready(v) = a.as_mut().poll(cx)
        {
            ra = Some(v);
        }
        if rb.is_none()
            && let Poll::Ready(v) = b.as_mut().poll(cx)
        {
            rb = Some(v);
        }
        if ra.is_some() && rb.is_some() {
            Poll::Ready((ra.take().unwrap(), rb.take().unwrap()))
        } else {
            Poll::Pending
        }
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn select_and_join() {
        let r = select2(std::future::ready(1), std::future::pending::<()>()).await;
        assert!(matches!(r, Either::Left(1)));
        let r = select2(std::future::pending::<()>(), async { 2 }).await;
        assert!(matches!(r, Either::Right(2)));
        assert_eq!(join2(async { 1 }, async { "x" }).await, (1, "x"));
    }
}
