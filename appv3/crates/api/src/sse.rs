//! Server-sent events: `\r\n` framing, a `: ping` comment every 15 s to
//! keep idle connections open, and no-buffering response headers.

use appv3_agent::WireEvent;
use axum::body::Body;
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::Response;
use bytes::Bytes;
use futures::{Stream, StreamExt};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

pub const PING_INTERVAL: Duration = Duration::from_secs(15);

/// A webview opens at most 6 HTTP/1.1 connections per host, shared by every
/// window. Long-lived streams hold one each, so at this many the next request
/// can queue behind them with no error. Logged as a warning to make that
/// visible in the log.
const NEAR_WEBVIEW_LIMIT: usize = 5;

/// Open SSE responses, for the log only.
#[derive(Default)]
pub struct StreamCounter(AtomicUsize);

static STREAMS: StreamCounter = StreamCounter(AtomicUsize::new(0));

impl StreamCounter {
    fn open(&'static self) -> StreamGuard {
        let active = self.0.fetch_add(1, Ordering::SeqCst) + 1;
        tracing::info!("sse_stream_open active={}", active);
        if active >= NEAR_WEBVIEW_LIMIT {
            tracing::warn!("sse_streams_near_webview_limit active={}", active);
        }
        StreamGuard(self)
    }

    pub fn active(&self) -> usize {
        self.0.load(Ordering::SeqCst)
    }
}

/// Dropped with the response body: on a normal end and on client disconnect.
struct StreamGuard(&'static StreamCounter);

impl Drop for StreamGuard {
    fn drop(&mut self) {
        let active = self.0 .0.fetch_sub(1, Ordering::SeqCst) - 1;
        tracing::info!("sse_stream_close active={}", active);
    }
}

/// Clients ignore comment lines, so the ping carries nothing.
const PING_FRAME: &[u8] = b": ping\r\n\r\n";

/// Wrap an event stream as an SSE response. The stream ending closes the
/// response (sse-starlette does the same when its generator returns).
pub fn sse_response<S>(events: S) -> Response
where
    S: Stream<Item = Arc<WireEvent>> + Send + 'static,
{
    sse_response_counted(events, &STREAMS)
}

fn sse_response_counted<S>(events: S, counter: &'static StreamCounter) -> Response
where
    S: Stream<Item = Arc<WireEvent>> + Send + 'static,
{
    let guard = counter.open();
    let body = async_stream::stream! {
        let _guard = guard;
        let mut events = Box::pin(events);
        let mut ticker = tokio::time::interval_at(tokio::time::Instant::now() + PING_INTERVAL, PING_INTERVAL);
        loop {
            tokio::select! {
                ev = events.next() => match ev {
                    Some(ev) => yield Ok::<Bytes, std::io::Error>(Bytes::from(ev.to_sse())),
                    None => break,
                },
                _ = ticker.tick() => yield Ok(Bytes::from_static(PING_FRAME)),
            }
        }
    };
    let mut resp = Response::new(Body::from_stream(body));
    *resp.status_mut() = StatusCode::OK;
    let h = resp.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/event-stream; charset=utf-8"));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    h.insert(header::CONNECTION, HeaderValue::from_static("keep-alive"));
    h.insert("x-accel-buffering", HeaderValue::from_static("no"));
    resp
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn idle_streams_get_a_fixed_ping_comment() {
        let resp = sse_response(futures::stream::pending::<Arc<WireEvent>>());
        let mut body = resp.into_body().into_data_stream();
        assert_eq!(&body.next().await.unwrap().unwrap()[..], b": ping\r\n\r\n");
    }

    #[tokio::test]
    async fn open_streams_are_counted_until_the_body_is_dropped() {
        static COUNTER: StreamCounter = StreamCounter(AtomicUsize::new(0));
        assert_eq!(COUNTER.active(), 0);
        let a = sse_response_counted(futures::stream::pending::<Arc<WireEvent>>(), &COUNTER);
        let b = sse_response_counted(futures::stream::pending::<Arc<WireEvent>>(), &COUNTER);
        assert_eq!(COUNTER.active(), 2);
        drop(a);
        assert_eq!(COUNTER.active(), 1);
        // A stream that ends by itself releases its slot too.
        let mut ended = sse_response_counted(futures::stream::empty::<Arc<WireEvent>>(), &COUNTER).into_body().into_data_stream();
        assert!(ended.next().await.is_none());
        drop(ended);
        drop(b);
        assert_eq!(COUNTER.active(), 0);
    }
}
