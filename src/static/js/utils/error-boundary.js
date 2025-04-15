/**
 * @fileoverview Defines an error boundary for handling various types of errors in the application.
 * It provides a set of predefined error codes and an ApplicationError class for consistent error handling.
 */

/**
 * Enumeration of error codes for different types of errors.
 * @enum {string}
 */
export const ErrorCodes = {
    // Audio related errors
    AUDIO_DEVICE_NOT_FOUND: 'AUDIO_DEVICE_NOT_FOUND',
    AUDIO_PERMISSION_DENIED: 'AUDIO_PERMISSION_DENIED',
    AUDIO_NOT_SUPPORTED: 'AUDIO_NOT_SUPPORTED',
    AUDIO_INITIALIZATION_FAILED: 'AUDIO_INITIALIZATION_FAILED',
    AUDIO_RECORDING_FAILED: 'AUDIO_RECORDING_FAILED',
    AUDIO_STOP_FAILED: 'AUDIO_STOP_FAILED',
    AUDIO_CONVERSION_FAILED: 'AUDIO_CONVERSION_FAILED',

    // WebSocket related errors
    WEBSOCKET_CONNECTION_FAILED: 'WEBSOCKET_CONNECTION_FAILED',
    WEBSOCKET_MESSAGE_FAILED: 'WEBSOCKET_MESSAGE_FAILED',
    WEBSOCKET_CLOSE_FAILED: 'WEBSOCKET_CLOSE_FAILED',

    // API related errors
    API_AUTHENTICATION_FAILED: 'API_AUTHENTICATION_FAILED',
    API_REQUEST_FAILED: 'API_REQUEST_FAILED',
    API_RESPONSE_INVALID: 'API_RESPONSE_INVALID',

    // General errors
    UNKNOWN_ERROR: 'UNKNOWN_ERROR',
    INVALID_STATE: 'INVALID_STATE',
    INVALID_PARAMETER: 'INVALID_PARAMETER',

    // Video related errors
    VIDEO_DEVICE_NOT_FOUND: 'VIDEO_DEVICE_NOT_FOUND',
    VIDEO_PERMISSION_DENIED: 'VIDEO_PERMISSION_DENIED',
    VIDEO_NOT_SUPPORTED: 'VIDEO_NOT_SUPPORTED',
    VIDEO_CODEC_NOT_SUPPORTED: 'VIDEO_CODEC_NOT_SUPPORTED',
    VIDEO_START_FAILED: 'VIDEO_START_FAILED',
    VIDEO_STOP_FAILED: 'VIDEO_STOP_FAILED',

    // Screen sharing related errors
    SCREEN_DEVICE_NOT_FOUND: 'SCREEN_DEVICE_NOT_FOUND',
    SCREEN_PERMISSION_DENIED: 'SCREEN_PERMISSION_DENIED',
    SCREEN_NOT_SUPPORTED: 'SCREEN_NOT_SUPPORTED',
    SCREEN_START_FAILED: 'SCREEN_START_FAILED',
    SCREEN_STOP_FAILED: 'SCREEN_STOP_FAILED',
};

/**
 * Custom error class for application-specific errors.
 * Extends the built-in Error class and adds properties for error code, details, and timestamp.
 */
export class ApplicationError extends Error {
    /**
     * Creates a new ApplicationError.
     *
     * @param {string} message - The error message.
     * @param {string} [code=ErrorCodes.UNKNOWN_ERROR] - The error code.
     * @param {Object} [details={}] - Additional details about the error.
     */
    constructor(message, code = ErrorCodes.UNKNOWN_ERROR, details = {}) {
        super(message);
        this.name = 'ApplicationError';
        this.code = code;
        this.details = details;
        this.timestamp = new Date().toISOString();

        // Ensure proper stack trace
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, ApplicationError);
        }
    }

    /**
     * Converts the error object to a JSON representation.
     *
     * @returns {Object} The JSON representation of the error.
     */
    toJSON() {
        return {
            name: this.name,
            message: this.message,
            code: this.code,
            details: this.details,
            timestamp: this.timestamp,
            stack: this.stack
        };
    }
}

/**
 * @fileoverview 全局错误处理工具类，用于捕获和处理未捕获的异常
 */

/**
 * 错误边界类，提供全局错误捕获和处理能力
 */
export class ErrorBoundary {
    /**
     * 初始化错误边界
     * @param {Object} options - 配置选项
     * @param {Function} options.onError - 错误处理回调
     * @param {boolean} options.silent - 是否静默处理错误（不显示给用户）
     * @param {number} options.autoHideDelay - 自动隐藏错误通知的延迟时间(ms)，默认5000ms
     */
    constructor(options = {}) {
        this.options = {
            onError: (error) => console.error('Uncaught error:', error),
            silent: false,
            autoHideDelay: 5000,
            ...options
        };
        
        this.setupGlobalHandlers();
        this.activeNotifications = new Set(); // 跟踪当前显示的错误通知
    }
    
    /**
     * 设置全局错误处理器
     * @private
     */
    setupGlobalHandlers() {
        // 处理未捕获的 Promise 异常
        window.addEventListener('unhandledrejection', (event) => {
            console.error('Unhandled Promise rejection:', event.reason);
            this.handleError(event.reason || new Error('未知的 Promise 异常'));
            event.preventDefault();
        });
        
        // 处理未捕获的 JS 异常
        window.addEventListener('error', (event) => {
            console.error('Uncaught error:', event.error || event.message);
            this.handleError(event.error || new Error(event.message));
            event.preventDefault();
        });
    }
    
    /**
     * 处理错误
     * @param {Error} error - 捕获的错误对象
     * @private
     */
    handleError(error) {
        // 标准化错误对象
        if (!(error instanceof Error)) {
            if (typeof error === 'string') {
                error = new Error(error);
            } else if (error && typeof error === 'object') {
                error = new Error(error.message || JSON.stringify(error));
            } else {
                error = new Error('发生了未知错误');
            }
        }

        // 调用错误回调
        this.options.onError(error);
        
        if (!this.options.silent) {
            this.showErrorToUser(error);
        }
    }
    
    /**
     * 向用户显示错误信息
     * @param {Error} error - 捕获的错误对象
     * @private
     */
    showErrorToUser(error) {
        // 获取友好的错误消息
        let errorMessage = this.getFriendlyErrorMessage(error);
        
        // 创建错误提示元素
        const errorContainer = document.createElement('div');
        errorContainer.className = 'error-notification';
        errorContainer.setAttribute('role', 'alert');
        errorContainer.setAttribute('aria-live', 'assertive');
        
        errorContainer.innerHTML = `
            <div class="error-notification-header">
                <span class="error-title">出错了</span>
                <button class="error-close" aria-label="关闭错误提示">&times;</button>
            </div>
            <div class="error-notification-body">
                <p>${errorMessage}</p>
            </div>
        `;
        
        // 添加到页面
        document.body.appendChild(errorContainer);
        this.activeNotifications.add(errorContainer);
        
        // 添加关闭按钮事件
        const closeButton = errorContainer.querySelector('.error-close');
        closeButton.addEventListener('click', () => {
            this.dismissNotification(errorContainer);
        });
        
        // 支持键盘事件
        closeButton.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                this.dismissNotification(errorContainer);
            }
        });
        
        // 自动隐藏
        if (this.options.autoHideDelay > 0) {
            setTimeout(() => {
                if (document.body.contains(errorContainer)) {
                    this.dismissNotification(errorContainer);
                }
            }, this.options.autoHideDelay);
        }
    }

    /**
     * 平滑关闭通知
     * @param {HTMLElement} notification - 通知元素
     */
    dismissNotification(notification) {
        if (!notification || !document.body.contains(notification)) return;
        
        notification.classList.add('closing');
        this.activeNotifications.delete(notification);
        
        // 动画结束后移除元素
        setTimeout(() => {
            if (document.body.contains(notification)) {
                document.body.removeChild(notification);
            }
        }, 300); // 300ms 是动画的持续时间
    }

    /**
     * 获取友好的错误消息
     * @param {Error} error - 错误对象
     * @returns {string} 友好的错误消息
     */
    getFriendlyErrorMessage(error) {
        // 根据错误类型提供友好的消息
        if (error.code) {
            switch(error.code) {
                case ErrorCodes.AUDIO_PERMISSION_DENIED:
                    return '无法访问麦克风。请确保您已授予麦克风权限，并且没有其他应用正在使用麦克风。';
                
                case ErrorCodes.SCREEN_PERMISSION_DENIED:
                    return '无法共享屏幕。请确保您已授予屏幕共享权限。';
                
                case ErrorCodes.WEBSOCKET_CONNECTION_FAILED:
                    return '连接服务器失败。请检查您的网络连接和 API Key 是否正确。';
                
                case ErrorCodes.API_AUTHENTICATION_FAILED:
                    return 'API 认证失败。请确保您输入了正确的 API Key。';
                
                default:
                    return error.message || '发生了未知错误';
            }
        }
        
        // 为常见错误提供友好消息
        if (error.name === 'NotAllowedError') {
            return '权限被拒绝。请确保您已授予相应的权限后重试。';
        }
        
        if (error.name === 'NotFoundError') {
            return '找不到需要的设备，如摄像头或麦克风。请确保您的设备已连接并正常工作。';
        }
        
        if (error.message && error.message.includes('API key')) {
            return 'API Key 无效或过期。请检查您的 API Key 是否正确。';
        }
        
        return error.message || '发生了未知错误';
    }
    
    /**
     * 包装函数，为其添加错误处理
     * @param {Function} fn - 要包装的函数
     * @returns {Function} 包装后的函数
     */
    wrapFunction(fn) {
        return (...args) => {
            try {
                const result = fn(...args);
                
                // 处理返回的 Promise
                if (result instanceof Promise) {
                    return result.catch(error => {
                        this.handleError(error);
                        throw error;
                    });
                }
                
                return result;
            } catch (error) {
                this.handleError(error);
                throw error;
            }
        };
    }

    /**
     * 关闭所有活动的通知
     */
    dismissAllNotifications() {
        this.activeNotifications.forEach(notification => {
            this.dismissNotification(notification);
        });
    }
}

// 创建默认的错误边界实例
const defaultErrorBoundary = new ErrorBoundary();

export default defaultErrorBoundary;